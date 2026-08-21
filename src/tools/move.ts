import type { InputRequiredResult } from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import { basename, dirname, resolve, sep } from 'node:path';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.js';
import {
  ErrorCode,
  FsError,
  isFsError,
  isNodeError,
  Problem,
  rethrowIfAborted,
} from '../core/errors.js';
import type { GuardedFileSystem } from '../core/fs.js';
import { Logger } from '../core/observability.js';
import { isSamePath } from '../core/path.js';
import { PerFileErrorSchema, RequiredPath } from '../core/schema.js';
import { PARALLEL_CONCURRENCY } from '../core/util.js';
import type { ToolCtx } from './define.js';
import { defineTool } from './define.js';
import { confirmInput, pendingRoundTrip, readAcceptedConfirm } from './input-required.js';

const MoveItemSchema = z.strictObject({
  source: RequiredPath.describe('Absolute path of the file or directory to move'),
  destination: RequiredPath.describe(
    'Absolute destination path; parent directories are created automatically',
  ),
});

const MoveItemResultSchema = z.strictObject({
  from: z.string().describe('Resolved absolute source path'),
  to: z.string().describe('Resolved absolute destination path'),
  ok: z
    .literal(true)
    .describe('Always true for this entry; failures are in the outer failures array'),
});

const MoveInputSchema = z.strictObject({
  moves: z
    .array(MoveItemSchema)
    .min(1)
    .max(100)
    .describe('List of move operations to perform (max 100); each requires source and destination'),
});

const MoveFailureItemSchema = z.strictObject({
  source: z.string().describe('The source path that could not be moved'),
  destination: z.string().describe('The intended destination path for the failed move'),
  error: PerFileErrorSchema,
});

type MoveFailureItem = z.infer<typeof MoveFailureItemSchema>;

const MoveOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Always true; per-move errors are in failures[]'),
  moves: z.array(MoveItemResultSchema).describe('Successfully completed move operations'),
  failures: z
    .array(MoveFailureItemSchema)
    .optional()
    .describe('Move operations that failed with per-item error details'),
});

type MoveItemResult = z.infer<typeof MoveItemResultSchema>;

/** A move pre-checked up to the point a confirmation decision is needed. */
interface MovePlan {
  move: { source: string; destination: string };
  renamePath: string;
  validDest: string;
  isCaseOnlyRename: boolean;
  /** Whether the destination existed when planned (drives the TOCTOU guard). */
  destExistedOriginally: boolean;
  /** Destination exists and is not a self/case-only move → needs overwrite confirmation. */
  pending: boolean;
}

type MovePlanResult =
  | { status: 'fail'; failure: MoveFailureItem }
  | { status: 'noop' }
  | { status: 'plan'; plan: MovePlan };

function moveFailure(
  move: { source: string; destination: string },
  error: unknown,
): MoveFailureItem {
  return {
    source: move.source,
    destination: move.destination,
    error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, move.source),
  };
}

/**
 * Phase 1 (no mutation): validate source and destination, reject self-moves and
 * moves into a subdirectory of the source, and stat the destination to decide
 * whether this move needs an overwrite confirmation. No `mkdir` happens here —
 * the old flow created the destination's parent before asking, which mutated
 * the filesystem before a confirmation; that now waits for phase 2 (R14).
 */
async function planMove(
  move: { source: string; destination: string },
  fs: ToolCtx['fs'],
): Promise<MovePlanResult> {
  let renamePath: string;
  let realPath: string;
  try {
    ({ renamePath, realPath } = await validateMoveSource(move.source, fs));
  } catch (error) {
    return { status: 'fail', failure: moveFailure(move, error) };
  }

  let validDest: string;
  try {
    validDest = await fs.pathGuard.validatePathForWrite(move.destination);
  } catch (error) {
    return { status: 'fail', failure: moveFailure(move, error) };
  }

  // Comparisons run on the resolved source; only the fs call below uses
  // renamePath. validatePathForWrite resolves the destination through a
  // symlink too, so both sides of every check must be resolved to match.
  const resolvedSource = resolve(realPath);
  const resolvedDest = resolve(validDest);

  if (resolvedSource === resolvedDest) {
    // Self-move — silently skip.
    return { status: 'noop' };
  }

  const platform = process.platform;
  const normalizedDest =
    platform === 'win32' || platform === 'darwin' ? resolvedDest.toLowerCase() : resolvedDest;
  const normalizedSource =
    platform === 'win32' || platform === 'darwin'
      ? (resolvedSource + sep).toLowerCase()
      : resolvedSource + sep;

  if (normalizedDest.startsWith(normalizedSource)) {
    return {
      status: 'fail',
      failure: moveFailure(
        move,
        new FsError(
          ErrorCode.INVALID_INPUT,
          'Cannot move a directory into its own subdirectory',
          move.source,
        ),
      ),
    };
  }

  const isCaseOnlyRename = isSamePath(resolvedSource, resolvedDest);
  let destExistedOriginally = false;
  if (!isCaseOnlyRename) {
    try {
      await fs.stat(validDest);
      destExistedOriginally = true;
    } catch (err) {
      if (isNodeError(err) && err.code !== 'ENOENT') {
        Logger.warn(`move: dest stat failed unexpectedly for "${validDest}": ${String(err)}`);
      }
    }
  }

  const pending = !isCaseOnlyRename && destExistedOriginally;
  return {
    status: 'plan',
    plan: { move, renamePath, validDest, isCaseOnlyRename, destExistedOriginally, pending },
  };
}

/**
 * Phase 2 (mutation): confirm an overwrite if needed, create the destination's
 * parent, TOCTOU-check the destination, then rename (with cross-device fallback).
 * A declined/missing confirmation throws `CANCELLED`, collected as a per-move
 * failure by the caller. A destination that appeared between plan and rename
 * (created during the confirmation gap) also fails closed.
 */
async function executeMove(
  plan: MovePlan,
  ctx: Pick<ToolCtx, 'fs' | 'signal' | 'inputResponses'>,
  pendingSorted: readonly string[],
): Promise<MoveItemResult> {
  if (plan.pending) {
    const key = `confirm_${pendingSorted.indexOf(plan.validDest)}`;
    if (!readAcceptedConfirm(ctx.inputResponses, key)) {
      throw new FsError(
        ErrorCode.CANCELLED,
        `Move cancelled: overwrite of "${plan.move.destination}" was declined or missing`,
        plan.move.destination,
      );
    }
  }

  await ctx.fs.mkdir(dirname(plan.validDest), { recursive: true });

  // TOCTOU check immediately before the rename: a destination that did not exist
  // when planned but exists now was created during the confirmation gap.
  let existsNow = false;
  if (!plan.isCaseOnlyRename) {
    try {
      await ctx.fs.stat(plan.validDest);
      existsNow = true;
    } catch (err) {
      if (isNodeError(err) && err.code !== 'ENOENT') {
        Logger.warn(`move: dest stat failed unexpectedly for "${plan.validDest}": ${String(err)}`);
      }
    }
  }
  if (existsNow && !plan.destExistedOriginally) {
    throw new FsError(
      ErrorCode.CANCELLED,
      `Move cancelled: destination "${plan.move.destination}" was created during confirmation.`,
      plan.move.destination,
    );
  }

  await performRenameWithFallback(plan.renamePath, plan.validDest, ctx.fs, plan.move.source);
  return { ok: true as const, from: plan.renamePath, to: plan.validDest };
}

/**
 * Two-phase move: pre-check every move (no mutation) to build the overwrite
 * pending set; if any move is pending and the round carries no verified
 * `requestState`, return `input_required` moving nothing (R14). On retry, R9
 * checks the state binds this move set, then each pending move proceeds only on
 * an accepted overwrite. Non-pending moves proceed alongside them.
 */
async function handleMove(
  args: z.infer<typeof MoveInputSchema>,
  ctx: ToolCtx,
): Promise<z.infer<typeof MoveOutputSchema> | InputRequiredResult> {
  const allPlans: MovePlan[] = [];
  const earlyFailures: MoveFailureItem[] = [];
  for (const move of args.moves) {
    const r = await planMove(move, ctx.fs);
    if (r.status === 'fail') earlyFailures.push(r.failure);
    else if (r.status === 'plan') allPlans.push(r.plan);
    // 'noop' (self-move) is silently skipped, as before.
  }

  // Two sources targeting the same destination in one batch would otherwise
  // collapse to a single shared overwrite confirmation and let the second
  // move silently clobber the first's freshly-written content. Fail closed:
  // only the first plan per destination proceeds; later ones targeting the
  // same destination are reported as a per-move failure.
  const seenDest = new Set<string>();
  const plans: MovePlan[] = [];
  for (const plan of allPlans) {
    if (seenDest.has(plan.validDest)) {
      earlyFailures.push(
        moveFailure(
          plan.move,
          new FsError(
            ErrorCode.INVALID_INPUT,
            `Move cancelled: another entry in this batch already targets destination "${plan.move.destination}"`,
            plan.move.destination,
          ),
        ),
      );
      continue;
    }
    seenDest.add(plan.validDest);
    plans.push(plan);
  }

  const pendingSorted = [...new Set(plans.filter((p) => p.pending).map((p) => p.validDest))].sort();

  if (pendingSorted.length > 0) {
    // Round 1 returns input_required; a retry whose verified state does not
    // bind this overwrite set throws (R9) via `pendingRoundTrip`.
    const round = await pendingRoundTrip({
      op: 'move',
      pending: pendingSorted,
      requestState: ctx.requestState,
      buildInputs: (ds) =>
        ds.map((d, i) => confirmInput(`confirm_${i}`, `"${d}" already exists. Overwrite it?`)),
    });
    if (round !== undefined) return round;
  }

  const executed = await processInParallel(
    plans,
    async (plan) => {
      try {
        const res = await executeMove(plan, ctx, pendingSorted);
        ctx.log?.('info', `move: ${plan.move.source} -> ${plan.move.destination}`, 'move');
        return { ok: true as const, res };
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        return { ok: false as const, failure: moveFailure(plan.move, err) };
      }
    },
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );

  const results: MoveItemResult[] = [];
  const failures = [...earlyFailures];
  for (const { value: r } of executed.results) {
    if (r.ok) {
      results.push(r.res);
    } else {
      failures.push(r.failure);
    }
  }
  for (const { index, error } of executed.errors) {
    const plan = plans[index];
    if (plan) {
      failures.push(moveFailure(plan.move, error));
    }
  }

  return {
    ok: true as const,
    moves: results,
    ...(failures.length > 0 ? { failures } : {}),
  };
}

function buildSummary(
  results: readonly MoveItemResult[],
  failures: readonly MoveFailureItem[],
): string {
  const successCount = results.length;
  const failCount = failures.length;
  if (failCount === 0 && successCount === 1) {
    const result = results[0];
    if (result) {
      return `move: ${basename(result.from)} → ${basename(result.to)}`;
    }
  }
  const parts = [`move: ${String(successCount)} item${successCount === 1 ? '' : 's'}`];
  if (failCount > 0) parts.push(`${String(failCount)} failed`);
  return parts.join(' · ');
}

interface MoveSource {
  /** Symlink preserved — the path actually handed to rename/cp/rm. */
  renamePath: string;
  /** Symlink resolved — the identity used for every same-target comparison. */
  realPath: string;
}

/**
 * A move needs two views of its source. Renaming must operate on the link
 * itself, or moving a symlink would rename the file it points at and leave the
 * link dangling. Every collision check must instead compare the resolved
 * target, or a link moved onto itself (or onto its own target) reads as a real
 * move and renames the link over that target, destroying it.
 */
async function validateMoveSource(source: string, fs: ToolCtx['fs']): Promise<MoveSource> {
  try {
    const realPath = await fs.pathGuard.validateExistingPath(source);
    const renamePath = await fs.pathGuard.validatePathForDelete(source);
    return { renamePath, realPath };
  } catch (error) {
    if (isFsError(error)) throw error;
    throw new FsError(ErrorCode.ACCESS_DENIED, `Move failed for ${source}`, source);
  }
}

async function performRenameWithFallback(
  validSource: string,
  validDest: string,
  fsOps: Pick<GuardedFileSystem, 'rename' | 'cp' | 'rm'>,
  originalSource: string,
): Promise<void> {
  try {
    await fsOps.rename(validSource, validDest);
  } catch (error: unknown) {
    rethrowIfAborted(error);

    if (!isNodeError(error) || error.code !== 'EXDEV') {
      // Preserve the original error code/message via cause so EPERM/EACCES/ENOSPC
      // surface instead of a generic UNKNOWN.
      throw new FsError(
        ErrorCode.UNKNOWN,
        `Move failed for ${originalSource}`,
        originalSource,
        undefined,
        error,
      );
    }

    // EXDEV: cross-device rename. Copy then remove, preserving symlinks and
    // timestamps so link semantics survive the move.
    let copied = false;
    try {
      await fsOps.cp(validSource, validDest, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      });
      copied = true;
      await fsOps.rm(validSource, { recursive: true, force: true });
    } catch (copyOrRemoveError) {
      rethrowIfAborted(copyOrRemoveError);
      if (copied) {
        // cp succeeded but rm failed: the destination already holds a complete
        // copy and the source remains. Surface the rm error as the cause so the
        // caller can recover (clean up the duplicate) instead of a silent generic
        // failure that hides the partial completion.
        throw new FsError(
          ErrorCode.UNKNOWN,
          `Cross-device move of ${originalSource}: copy succeeded but source removal failed (destination holds a copy)`,
          originalSource,
          undefined,
          copyOrRemoveError,
        );
      }
      throw new FsError(
        ErrorCode.UNKNOWN,
        `Cross-device move failed for ${originalSource}`,
        originalSource,
        undefined,
        copyOrRemoveError,
      );
    }
  }
}

export const MOVE = defineTool({
  name: 'move',
  title: 'Move Files',
  description:
    'Move or rename files and directories to explicit destination paths (max 100 operations per call). ' +
    'Parent directories are created automatically. Self-moves are silently skipped.',
  input: MoveInputSchema,
  output: MoveOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  progress: (args) => {
    if (args.moves.length === 1) {
      const move = args.moves[0];
      return {
        label: 'Move',
        subject: `${basename(move?.source ?? '')} → ${basename(move?.destination ?? '')}`,
      };
    }
    return { label: 'Move', subject: `${String(args.moves.length)} files` };
  },
  defaultErrorCode: ErrorCode.UNKNOWN,
  accessPaths: (args) => args.moves.flatMap((m) => [m.source, m.destination]),
  run: async (args, ctx) => {
    const output = await handleMove(args, ctx);
    // input_required is a return value, not a completed call: surface it
    // verbatim so the executor short-circuits before building a CallToolResult.
    if (isInputRequiredResult(output)) return output;
    return { structured: output, text: buildSummary(output.moves, output.failures ?? []) };
  },
});
