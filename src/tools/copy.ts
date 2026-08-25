import type { InputRequiredResult } from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import { basename, dirname } from 'node:path';

import * as z from 'zod/v4';

import { ErrorCode, FsError } from '../core/errors.js';
import { destExists } from '../core/fs.js';
import { readAcceptedChoice } from '../core/input-required.js';
import { isPathInsideDirectory, isSamePath } from '../core/path.js';
import { defaultFalseBoolean, pairFailureSchema, RequiredPath } from '../core/schema.js';
import type { PairExecResult, PairPlanResult } from './batch.js';
import { pairFailure, runOverPairs } from './batch.js';
import type { ToolCtx } from './define.js';
import { defineTool } from './define.js';

const CopyItemSchema = z.strictObject({
  source: RequiredPath.describe('Absolute path of the file or directory to copy'),
  destination: RequiredPath.describe('Absolute destination path'),
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

const CopyFailureItemSchema = pairFailureSchema('copied', 'copy');

const CopyOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Always true; per-copy errors are in failures[]'),
  copies: z.array(CopyItemResultSchema).describe('Successfully completed copy operations'),
  failures: z
    .array(CopyFailureItemSchema)
    .optional()
    .describe('Copy operations that failed with per-item error details'),
  skipped: z
    .array(z.string())
    .optional()
    .describe('Destinations skipped because the user chose Skip'),
});

type CopyItemResult = z.infer<typeof CopyItemResultSchema>;

interface CopyPlan {
  pair: { source: string; destination: string };
  realSource: string;
  validDest: string;
  destExistedOriginally: boolean;
  pending: boolean;
}

async function planCopy(
  copy: { source: string; destination: string },
  fs: ToolCtx['fs'],
  overwrite: boolean,
): Promise<PairPlanResult<CopyPlan>> {
  let realSource: string;
  try {
    realSource = await fs.pathGuard.validateExistingPath(copy.source);
  } catch (error) {
    return { status: 'fail', failure: pairFailure(copy, error) };
  }

  let validDest: string;
  try {
    validDest = await fs.pathGuard.validatePathForWrite(copy.destination);
  } catch (error) {
    return { status: 'fail', failure: pairFailure(copy, error) };
  }

  if (isSamePath(realSource, validDest)) {
    // Self-copy — noop
    return { status: 'noop' };
  }

  if (isPathInsideDirectory(realSource, validDest)) {
    return {
      status: 'fail',
      failure: pairFailure(
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
    plan: { pair: copy, realSource, validDest, destExistedOriginally, pending },
  };
}

async function executeCopy(
  plan: CopyPlan,
  ctx: Pick<ToolCtx, 'fs' | 'signal' | 'inputResponses'>,
  pendingSorted: readonly string[],
  overwrite: boolean,
): Promise<PairExecResult<CopyItemResult>> {
  if (plan.pending && !overwrite) {
    const key = `confirm_${pendingSorted.indexOf(plan.validDest)}`;
    const choice = readAcceptedChoice(ctx.inputResponses, key);
    if (choice === 'skip') {
      return { skipped: plan.pair.destination };
    }
    if (choice !== 'overwrite') {
      throw new FsError(
        ErrorCode.CANCELLED,
        `Copy cancelled: overwrite of "${plan.pair.destination}" was declined or missing`,
        plan.pair.destination,
      );
    }
  }

  // TOCTOU check before any mutation: a destination that did not exist when
  // planned but exists now was created during the confirmation gap.
  if ((await destExists(ctx.fs, plan.validDest, 'copy')) && !plan.destExistedOriginally) {
    throw new FsError(
      ErrorCode.CANCELLED,
      `Copy cancelled: destination "${plan.pair.destination}" was created during confirmation.`,
      plan.pair.destination,
    );
  }

  await ctx.fs.mkdir(dirname(plan.validDest), { recursive: true });

  await ctx.fs.cp(plan.realSource, plan.validDest, {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    force: true,
  });

  return { value: { ok: true as const, from: plan.realSource, to: plan.validDest } };
}

async function handleCopy(
  args: z.infer<typeof CopyInputSchema>,
  ctx: ToolCtx,
): Promise<{ structured: z.infer<typeof CopyOutputSchema>; text: string } | InputRequiredResult> {
  const outcome = await runOverPairs(args.copies, ctx, {
    op: 'copy',
    plan: (copy) => planCopy(copy, ctx.fs, args.overwrite),
    execute: (plan, pendingSorted) => executeCopy(plan, ctx, pendingSorted, args.overwrite),
  });
  if (isInputRequiredResult(outcome)) return outcome;

  const { results: copies, skipped, failures: finalFailures } = outcome;

  const structured: z.infer<typeof CopyOutputSchema> = {
    ok: true as const,
    copies,
    ...(finalFailures.length > 0 ? { failures: finalFailures } : {}),
    ...(skipped.length > 0 ? { skipped } : {}),
  };

  const lines: string[] = [];
  if (copies.length > 0) {
    lines.push(`Copied ${copies.length} path(s):`);
    for (const c of copies) {
      lines.push(`  ${c.from} -> ${c.to}`);
    }
  } else if (finalFailures.length === 0 && skipped.length === 0) {
    lines.push('copy: 0 paths');
  }
  if (skipped.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Skipped ${skipped.length} destination(s):`);
    for (const p of skipped) {
      lines.push(`  ${p}`);
    }
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
  output: CopyOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
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
