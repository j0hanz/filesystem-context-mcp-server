import type { InputRequiredResult } from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import { basename, dirname } from 'node:path';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.js';
import { ErrorCode, FsError, Problem, rethrowIfAborted } from '../core/errors.js';
import { destExists } from '../core/fs.js';
import { confirmInput, pendingRoundTrip, readAcceptedConfirm } from '../core/input-required.js';
import { isPathInsideDirectory, isSamePath } from '../core/path.js';
import {
  completablePath,
  defaultFalseBoolean,
  PerFileErrorSchema,
  RequiredPath,
} from '../core/schema.js';
import { PARALLEL_CONCURRENCY } from '../core/util.js';
import type { ToolCtx } from './define.js';
import { defineTool } from './define.js';

const CopyItemSchema = z.strictObject({
  source: RequiredPath.describe('Absolute path of the file or directory to copy'),
  destination: RequiredPath.describe(
    'Absolute destination path; parent directories are created automatically',
  ),
});

const CopyInputSchema = z.strictObject({
  copies: z
    .array(CopyItemSchema)
    .min(1)
    .max(100)
    .describe('List of copy operations to perform (max 100); each requires source and destination'),
  overwrite: defaultFalseBoolean('Overwrite destination if it already exists (default: false)'),
});

const CopyItemResultSchema = z.strictObject({
  from: z.string().describe('Resolved absolute source path'),
  to: z.string().describe('Resolved absolute destination path'),
  ok: z
    .literal(true)
    .describe('Always true for this entry; failures are in the outer failures array'),
});

const CopyFailureItemSchema = z.strictObject({
  source: z.string().describe('The source path that could not be copied'),
  destination: z.string().describe('The intended destination path for the failed copy'),
  error: PerFileErrorSchema,
});

type CopyFailureItem = z.infer<typeof CopyFailureItemSchema>;

const CopyOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Always true; per-copy errors are in failures[]'),
  copies: z.array(CopyItemResultSchema).describe('Successfully completed copy operations'),
  failures: z
    .array(CopyFailureItemSchema)
    .optional()
    .describe('Copy operations that failed with per-item error details'),
});

type CopyItemResult = z.infer<typeof CopyItemResultSchema>;

interface CopyPlan {
  copy: { source: string; destination: string };
  realSource: string;
  validDest: string;
  destExistedOriginally: boolean;
  pending: boolean;
}

type CopyPlanResult =
  | { status: 'fail'; failure: CopyFailureItem }
  | { status: 'noop' }
  | { status: 'plan'; plan: CopyPlan };

function copyFailure(
  copy: { source: string; destination: string },
  error: unknown,
): CopyFailureItem {
  return {
    source: copy.source,
    destination: copy.destination,
    error: Problem.toPerFileError(error, ErrorCode.UNKNOWN, copy.source),
  };
}

async function planCopy(
  copy: { source: string; destination: string },
  fs: ToolCtx['fs'],
  overwrite: boolean,
): Promise<CopyPlanResult> {
  let realSource: string;
  try {
    realSource = await fs.pathGuard.validateExistingPath(copy.source);
  } catch (error) {
    return { status: 'fail', failure: copyFailure(copy, error) };
  }

  let validDest: string;
  try {
    validDest = await fs.pathGuard.validatePathForWrite(copy.destination);
  } catch (error) {
    return { status: 'fail', failure: copyFailure(copy, error) };
  }

  if (isSamePath(realSource, validDest)) {
    // Self-copy — noop
    return { status: 'noop' };
  }

  if (isPathInsideDirectory(realSource, validDest)) {
    return {
      status: 'fail',
      failure: copyFailure(
        copy,
        new FsError(
          ErrorCode.INVALID_INPUT,
          'Cannot copy a directory into its own subdirectory',
          copy.source,
        ),
      ),
    };
  }

  const destExistedOriginally = await destExists(fs, validDest, 'copy');

  const pending = destExistedOriginally && !overwrite;
  return {
    status: 'plan',
    plan: { copy, realSource, validDest, destExistedOriginally, pending },
  };
}

async function executeCopy(
  plan: CopyPlan,
  ctx: Pick<ToolCtx, 'fs' | 'signal' | 'inputResponses'>,
  pendingSorted: readonly string[],
  overwrite: boolean,
): Promise<CopyItemResult> {
  if (plan.pending && !overwrite) {
    const key = `confirm_${pendingSorted.indexOf(plan.validDest)}`;
    if (!readAcceptedConfirm(ctx.inputResponses, key)) {
      throw new FsError(
        ErrorCode.CANCELLED,
        `Copy cancelled: overwrite of "${plan.copy.destination}" was declined or missing`,
        plan.copy.destination,
      );
    }
  }

  // TOCTOU check before any mutation: a destination that did not exist when
  // planned but exists now was created during the confirmation gap.
  if ((await destExists(ctx.fs, plan.validDest, 'copy')) && !plan.destExistedOriginally) {
    throw new FsError(
      ErrorCode.CANCELLED,
      `Copy cancelled: destination "${plan.copy.destination}" was created during confirmation.`,
      plan.copy.destination,
    );
  }

  await ctx.fs.mkdir(dirname(plan.validDest), { recursive: true });

  await ctx.fs.cp(plan.realSource, plan.validDest, {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    force: true,
  });

  return { ok: true as const, from: plan.realSource, to: plan.validDest };
}

async function handleCopy(
  args: z.infer<typeof CopyInputSchema>,
  ctx: ToolCtx,
): Promise<{ structured: z.infer<typeof CopyOutputSchema>; text: string } | InputRequiredResult> {
  const { results: plans } = await processInParallel(
    args.copies,
    (copy) => planCopy(copy, ctx.fs, args.overwrite),
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );

  const initialFailures: CopyFailureItem[] = [];
  const candidatePlans: CopyPlan[] = [];

  for (const res of plans) {
    if (res.value.status === 'fail') {
      initialFailures.push(res.value.failure);
    } else if (res.value.status === 'plan') {
      candidatePlans.push(res.value.plan);
    }
  }

  const isCaseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  const seenDest = new Set<string>();
  const readyPlans: CopyPlan[] = [];
  const pendingSet = new Set<string>();

  for (const plan of candidatePlans) {
    const destKey = isCaseInsensitive ? plan.validDest.toLowerCase() : plan.validDest;
    if (seenDest.has(destKey)) {
      initialFailures.push(
        copyFailure(
          plan.copy,
          new FsError(
            ErrorCode.INVALID_INPUT,
            `Copy cancelled: another entry in this batch already targets destination "${plan.copy.destination}"`,
            plan.copy.destination,
          ),
        ),
      );
      continue;
    }
    seenDest.add(destKey);
    readyPlans.push(plan);
    if (plan.pending) {
      pendingSet.add(plan.validDest);
    }
  }

  const pendingSorted = Array.from(pendingSet).sort();
  if (pendingSorted.length > 0) {
    const round = await pendingRoundTrip({
      op: 'copy',
      pending: pendingSorted,
      requestState: ctx.requestState,
      buildInputs: (dests) =>
        dests.map((dest, i) =>
          confirmInput(`confirm_${i}`, `Destination "${dest}" already exists. Overwrite it?`),
        ),
    });
    if (round !== undefined) return round;
  }

  const { results: execResults, errors: execErrors } = await processInParallel(
    readyPlans,
    (plan) => executeCopy(plan, ctx, pendingSorted, args.overwrite),
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );

  const finalFailures: CopyFailureItem[] = [...initialFailures];
  for (const { error, index } of execErrors) {
    rethrowIfAborted(error);
    const plan = readyPlans[index];
    if (plan) {
      finalFailures.push(copyFailure(plan.copy, error));
    }
  }

  const copies = execResults.map((r) => r.value);
  const structured: z.infer<typeof CopyOutputSchema> = {
    ok: true as const,
    copies,
    ...(finalFailures.length > 0 ? { failures: finalFailures } : {}),
  };

  const lines: string[] = [];
  if (copies.length > 0) {
    lines.push(`Copied ${copies.length} path(s):`);
    for (const c of copies) {
      lines.push(`  ${c.from} -> ${c.to}`);
    }
  } else if (finalFailures.length === 0) {
    lines.push('copy: 0 paths');
  }
  if (finalFailures.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Failed to copy ${finalFailures.length} path(s):`);
    for (const f of finalFailures) {
      lines.push(`  ${f.source} -> ${f.destination}: ${f.error.message}`);
    }
  }

  return { structured, text: lines.join('\n') };
}

export const COPY_FILES = defineTool({
  name: 'copy',
  title: 'Copy Files',
  description:
    'Copy files or directories to destination paths (max 100 operations per call). ' +
    'Supports recursive directory copying with timestamp and symlink preservation. ' +
    'Destination parent directories are created automatically.',
  input: CopyInputSchema,
  buildInput: (guard) =>
    CopyInputSchema.extend({
      copies: z
        .array(
          z.strictObject({
            source: completablePath(
              guard,
              'source',
              'Absolute path of the file or directory to copy',
            ),
            destination: completablePath(
              guard,
              'destination',
              'Absolute destination path; parent directories are created automatically',
            ),
          }),
        )
        .min(1)
        .max(100)
        .describe(
          'List of copy operations to perform (max 100); each requires source and destination',
        ),
    }),
  output: CopyOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  execution: {
    taskSupport: 'optional',
  },
  progress: (args) => {
    const firstCopy = args.copies[0];
    const subject =
      args.copies.length > 1
        ? `${args.copies.length} paths`
        : firstCopy
          ? `${basename(firstCopy.source)} -> ${basename(firstCopy.destination)}`
          : '';
    return { label: 'Copy', subject };
  },
  accessPaths: (args) => args.copies.flatMap((c) => [c.source, c.destination]),
  run: async (args, ctx) => {
    const result = await handleCopy(args, ctx);
    if (isInputRequiredResult(result)) return result;
    return { structured: result.structured, text: result.text };
  },
});
