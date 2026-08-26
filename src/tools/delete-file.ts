import type { InputRequiredResult } from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.js';
import { ErrorCode, isFsError, isNodeError, isNotFoundErrno, Problem } from '../core/errors.js';
import type { FileType, GuardedFileSystem } from '../core/fs.js';
import { getFileType } from '../core/fs.js';
import { choiceInput, pendingRoundTrip, readAcceptedChoice } from '../core/input-required.js';
import { defaultFalseBoolean, PathFailureSchema, RequiredPath } from '../core/schema.js';
import { PARALLEL_CONCURRENCY } from '../core/util.js';
import type { ToolCtx } from './define.js';
import { defineTool } from './define.js';

const DeleteInputSchema = z.strictObject({
  paths: z
    .array(RequiredPath)
    .min(1)
    .max(1000)
    .describe('Paths to delete (max 1000); accepts files, directories, or symlinks'),
  recursive: defaultFalseBoolean(
    'Delete directory contents recursively (required for non-empty directories)',
  ),
  ignoreIfNotExists: defaultFalseBoolean(
    'Silently succeed if a path does not exist instead of returning an error',
  ),
});

const DeleteOutputSchema = z.strictObject({
  ok: z
    .boolean()
    .describe(
      'True only when all requested paths were deleted successfully; false if any path failed',
    ),
  path: z.string().optional().describe('Deleted path (present when exactly one path was deleted)'),
  paths: z
    .array(z.string())
    .optional()
    .describe('Deleted paths (present when multiple paths were deleted)'),
  failures: z
    .array(PathFailureSchema)
    .optional()
    .describe('Per-path error details for paths that could not be deleted'),
  skipped: z.array(z.string()).optional().describe('Paths skipped because the user chose Skip'),
});

type DeleteInput = z.infer<typeof DeleteInputSchema>;
type DeleteOutput = z.infer<typeof DeleteOutputSchema>;
type DeleteFailureItem = z.infer<typeof PathFailureSchema>;

// Internal types for error handling
interface DeletedItem {
  path: string;
}
interface DeleteFailure {
  path: string;
  error: {
    code: string;
    message: string;
    path?: string;
    suggestion?: string;
  };
}

const ERR_NOT_EMPTY = new Error('Directory not empty. Set recursive: true.');

function toDeleteFailure(path: string, error: unknown): DeleteFailure {
  if (
    isNodeError(error) &&
    (error.code === 'ENOTEMPTY' || error.code === 'EISDIR' || error.code === 'EEXIST')
  ) {
    return {
      path,
      error: Problem.toPerFileError(ERR_NOT_EMPTY, ErrorCode.INVALID_INPUT, path),
    };
  }
  return { path, error: Problem.toPerFileError(error, ErrorCode.UNKNOWN, path) };
}

type LstatResult = Awaited<ReturnType<GuardedFileSystem['lstat']>>;
type ItemType = FileType;

/** A path's pre-checked plan: validated, statted, and flagged if it needs confirmation. */
interface DeletePlan {
  inputPath: string;
  validPath: string;
  itemType: ItemType;
  firstStats: LstatResult;
  /** Recursive + non-empty directory: needs a round-trip confirmation. */
  pending: boolean;
}

type PlanResult =
  | { status: 'fail'; failure: DeleteFailure }
  | { status: 'noop'; item: DeletedItem }
  | { status: 'plan'; plan: DeletePlan };

/**
 * Phase 1 (no mutation): validate, stat, and decide whether a path needs a
 * confirmation before anything is deleted. A pending path is a recursive
 * non-empty directory; everything else is ready to delete directly.
 */
async function planPath(
  inputPath: string,
  args: Pick<DeleteInput, 'recursive' | 'ignoreIfNotExists'>,
  fs: Pick<GuardedFileSystem, 'pathGuard' | 'lstat' | 'hasChildrenUnchecked'>,
): Promise<PlanResult> {
  let validPath: string;
  try {
    validPath = await fs.pathGuard.validatePathForDelete(inputPath);
  } catch (error) {
    if (
      args.ignoreIfNotExists &&
      ((isFsError(error) && error.code === ErrorCode.NOT_FOUND) || isNotFoundErrno(error))
    ) {
      return { status: 'noop', item: { path: inputPath } };
    }
    return { status: 'fail', failure: toDeleteFailure(inputPath, error) };
  }

  if (fs.pathGuard.isAllowedRoot(validPath)) {
    return {
      status: 'fail',
      failure: {
        path: validPath,
        error: Problem.accessDenied('Deleting a workspace root directory is not allowed', {
          path: validPath,
        }),
      },
    };
  }

  let firstStats: LstatResult;
  try {
    firstStats = await fs.lstat(validPath);
  } catch (error) {
    if (isNotFoundErrno(error) && args.ignoreIfNotExists) {
      return { status: 'noop', item: { path: validPath } };
    }
    return { status: 'fail', failure: toDeleteFailure(inputPath, error) };
  }

  const itemType = getFileType(firstStats.stats);
  let hasChildren = false;
  if (args.recursive && itemType === 'directory') {
    try {
      hasChildren = await fs.hasChildrenUnchecked(validPath);
    } catch (error) {
      return { status: 'fail', failure: toDeleteFailure(inputPath, error) };
    }
  }
  const pending = hasChildren;
  return { status: 'plan', plan: { inputPath, validPath, itemType, firstStats, pending } };
}

async function performDeletion(
  validPath: string,
  args: Pick<DeleteInput, 'recursive' | 'ignoreIfNotExists'>,
  isDirectory: boolean,
  fsOps: Pick<GuardedFileSystem, 'rm' | 'rmdir'>,
): Promise<void> {
  if (isDirectory && !args.recursive) {
    await fsOps.rmdir(validPath);
  } else {
    await fsOps.rm(validPath, {
      recursive: args.recursive,
      force: args.ignoreIfNotExists,
    });
  }
}

/**
 * Phase 2 (mutation): TOCTOU re-stat against the plan's first stat, then
 * delete. A type or identity change across the confirmation gap fails closed
 * rather than deleting a replacement object the user never confirmed.
 */
async function finalizeDeletion(
  plan: DeletePlan,
  args: Pick<DeleteInput, 'recursive' | 'ignoreIfNotExists'>,
  ctx: Pick<ToolCtx, 'fs' | 'log'>,
): Promise<{ item: DeletedItem } | { failure: DeleteFailure }> {
  let currentStats: LstatResult;
  try {
    currentStats = await ctx.fs.lstat(plan.validPath);
  } catch (error) {
    if (isNotFoundErrno(error) && args.ignoreIfNotExists) {
      return { item: { path: plan.validPath } };
    }
    return { failure: toDeleteFailure(plan.inputPath, error) };
  }

  const currentItemType = getFileType(currentStats.stats);
  // Identity comparison, not just the coarse category: a swap during the
  // confirmation gap (delete original, create a same-named replacement) keeps
  // the type but changes dev/ino/birthtimeMs. birthtimeMs is the primary
  // cross-platform signal — dev/ino can read 0 on some non-POSIX drivers — so
  // combine all three rather than trusting dev/ino alone.
  const identityChanged =
    plan.firstStats.stats.dev !== currentStats.stats.dev ||
    plan.firstStats.stats.ino !== currentStats.stats.ino ||
    plan.firstStats.stats.birthtimeMs !== currentStats.stats.birthtimeMs;
  if (plan.itemType !== 'other' && (currentItemType !== plan.itemType || identityChanged)) {
    return {
      failure: {
        path: plan.validPath,
        error: Problem.invalidInput(
          `Delete failed: item type changed from ${plan.itemType} to ${currentItemType} during confirmation.`,
          { path: plan.validPath },
        ),
      },
    };
  }

  try {
    await performDeletion(plan.validPath, args, currentStats.stats.isDirectory(), ctx.fs);
  } catch (error) {
    return { failure: toDeleteFailure(plan.inputPath, error) };
  }

  ctx.log?.('info', `rm: ${plan.inputPath}`, 'delete');
  return { item: { path: plan.validPath } };
}

/**
 * Execute one planned path on the retry round. A pending path deletes only on
 * an accepted `confirm: true`; decline, cancel, or a missing key report
 * `CANCELLED` for that path (R3 proceed, R4/R5 cancelled). A non-pending path
 * deletes directly (R14: non-pending items proceed alongside accepted ones).
 */
async function executePlan(
  plan: DeletePlan,
  args: Pick<DeleteInput, 'recursive' | 'ignoreIfNotExists'>,
  ctx: Pick<ToolCtx, 'fs' | 'inputResponses' | 'log'>,
  pendingSorted: readonly string[],
): Promise<{ item: DeletedItem } | { failure: DeleteFailure } | { skipped: true; path: string }> {
  if (plan.pending) {
    const key = `confirm_${pendingSorted.indexOf(plan.validPath)}`;
    const choice = readAcceptedChoice(ctx.inputResponses, key);
    if (choice === 'skip') {
      return { skipped: true as const, path: plan.validPath };
    }
    if (choice !== 'delete') {
      return {
        failure: {
          path: plan.validPath,
          error: Problem.cancelled('Delete cancelled: confirmation was declined or missing', {
            path: plan.validPath,
          }),
        },
      };
    }
  }
  return finalizeDeletion(plan, args, ctx);
}

async function handleDelete(
  args: DeleteInput,
  ctx: ToolCtx,
): Promise<DeleteOutput | InputRequiredResult> {
  // Phase 1 (no mutation): plan every path.
  const planned = await processInParallel(
    args.paths,
    (inputPath) => planPath(inputPath, args, ctx.fs),
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );

  const plans: DeletePlan[] = [];
  const earlyFailures: DeleteFailure[] = [];
  const earlyNoop: DeletedItem[] = [];
  for (const { value: r } of planned.results) {
    if (r.status === 'fail') earlyFailures.push(r.failure);
    else if (r.status === 'noop') earlyNoop.push(r.item);
    else plans.push(r.plan);
  }
  for (const { index, error } of planned.errors) {
    const path = args.paths[index] ?? '(unknown)';
    earlyFailures.push({ path, error: { code: ErrorCode.UNKNOWN, message: error.message } });
  }

  // Pending set: recursive + non-empty directories, sorted and de-duplicated.
  // `buildInputRequired` seals exactly this set into the requestState, and the
  // retried round recomputes it from the same args so a swapped retry (accept
  // for X, retry with Y) is rejected — the codec only proves the state was not
  // tampered, not that it matches the current request (R9).
  const pendingSorted = [...new Set(plans.filter((p) => p.pending).map((p) => p.validPath))].sort();

  if (pendingSorted.length > 0) {
    // Round 1 returns input_required (atomic — R14: nothing deleted yet, not
    // even the non-pending items in the same call); a retry whose verified
    // state does not bind this pending set throws (R9) via `pendingRoundTrip`.
    const round = await pendingRoundTrip({
      op: 'delete',
      pending: pendingSorted,
      requestState: ctx.requestState,
      clientCapabilities: ctx.clientCapabilities,
      buildInputs: (ps) =>
        ps.map((p, i) =>
          choiceInput(
            `confirm_${i}`,
            `Permanently delete "${p}" and all its contents? This cannot be undone.`,
            [
              { value: 'delete', title: 'Delete' },
              { value: 'skip', title: 'Skip' },
            ],
          ),
        ),
    });
    if (round !== undefined) return round;
  }

  // Phase 2 (mutation): execute deletions for every planned path.
  const executed = await processInParallel(
    plans,
    (plan) => executePlan(plan, args, ctx, pendingSorted),
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );

  const successPaths: string[] = earlyNoop.map((n) => n.path);
  const failures: DeleteFailureItem[] = [];
  const skipped: string[] = [];
  for (const f of earlyFailures) {
    failures.push({ path: f.path, error: f.error });
  }
  for (const { value: r } of executed.results) {
    if ('skipped' in r) {
      skipped.push(r.path);
    } else if ('failure' in r) {
      failures.push({ path: r.failure.path, error: r.failure.error });
    } else if (r.item.path) {
      successPaths.push(r.item.path);
    }
  }
  for (const { index, error } of executed.errors) {
    const plan = plans[index];
    const path = plan?.validPath ?? '(unknown)';
    failures.push({ path, error: { code: ErrorCode.UNKNOWN, message: error.message } });
  }

  const ok = failures.length === 0;
  const output: DeleteOutput = { ok };
  if (successPaths.length === 1) {
    output.path = successPaths[0];
  } else if (successPaths.length > 1) {
    output.paths = successPaths;
  }
  if (failures.length > 0) {
    output.failures = failures;
  }
  if (skipped.length > 0) {
    output.skipped = skipped;
  }
  return output;
}

export const DELETE_FILE = defineTool({
  name: 'delete',
  title: 'Delete File',
  description:
    'Permanently delete one or more files, directories, or symlinks (max 1000 per call). This action is irreversible. ' +
    'Non-empty directories require recursive=true and additionally prompt the user to confirm each one, ' +
    'so the call returns without deleting anything until that confirmation comes back; ' +
    'a client that cannot prompt gets an error naming the alternative. ' +
    'Workspace root directories cannot be deleted.',
  input: DeleteInputSchema,
  output: DeleteOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  defaultErrorCode: ErrorCode.UNKNOWN,
  progress: (args) => ({
    label: 'Delete',
    subject:
      args.paths.length === 1
        ? basename(args.paths[0] ?? '')
        : `${String(args.paths.length)} paths`,
  }),
  accessPaths: (args) => [...args.paths],
  run: async (args, ctx) => {
    const structured = await handleDelete(args, ctx);
    // input_required is a return value, not a completed call: surface it
    // verbatim so the executor short-circuits before building a CallToolResult.
    if (isInputRequiredResult(structured)) return structured;
    const deleted = structured.paths ?? (structured.path ? [structured.path] : []);
    const failCount = structured.failures?.length ?? 0;
    const delCount = deleted.length;
    const failSuffix =
      failCount > 0 ? `, ${String(failCount)} failure${failCount === 1 ? '' : 's'}` : '';
    const summary =
      delCount > 0
        ? `delete: deleted ${delCount === 1 ? (deleted[0] ?? '') : `${String(delCount)} paths`}${failSuffix}`
        : `delete: ${String(failCount)} failure${failCount === 1 ? '' : 's'}`;
    return { structured, text: summary };
  },
});
