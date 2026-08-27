import type { InputRequiredResult } from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import { basename, dirname, resolve, sep } from 'node:path';

import * as z from 'zod/v4';

import {
  ErrorCode,
  FsError,
  isFsError,
  isNodeError,
  Problem,
  rethrowIfAborted,
} from '../core/errors.js';
import { joinRoster, pathLabel } from '../core/fmt.js';
import { destExists } from '../core/fs.js';
import type { GuardedFileSystem } from '../core/fs.js';
import { readAcceptedChoice } from '../core/input-required.js';
import { IS_CASE_INSENSITIVE_FS, isPathInsideDirectory, isSamePath } from '../core/path-utils.js';
import { defaultFalseBoolean, pairFailureSchema, RequiredPath } from '../core/schema.js';
import type { PairExecResult, PairPlanResult } from './batch.js';
import { pairFailure, runOverPairs } from './batch.js';
import type { ToolCtx } from './define.js';
import { defineTool } from './define.js';

const MoveItemSchema = z.strictObject({
  source: RequiredPath.describe('Path of the file or directory to move or copy'),
  destination: RequiredPath.describe('Destination path'),
});

const MoveItemResultSchema = z.strictObject({
  from: z.string().describe('Resolved absolute source path'),
  to: z.string().describe('Resolved absolute destination path'),
});

const MoveInputSchema = z.strictObject({
  moves: z.array(MoveItemSchema).min(1).max(100).describe('Operations to perform (max 100)'),
  copy: defaultFalseBoolean('Copy instead of move; sources are left in place'),
  overwrite: defaultFalseBoolean(
    'Copy mode only: overwrite existing destinations without confirmation',
  ),
});

const MoveFailureItemSchema = pairFailureSchema('moved', 'move');

type MoveFailureItem = z.infer<typeof MoveFailureItemSchema>;

const MoveOutputSchema = z.strictObject({
  moves: z.array(MoveItemResultSchema).describe('Successfully completed operations'),
  failures: z
    .array(MoveFailureItemSchema)
    .optional()
    .describe('Operations that failed with per-item error details'),
  skipped: z
    .array(z.string())
    .optional()
    .describe('Destinations skipped because the user chose Skip'),
});

type MoveItemResult = z.infer<typeof MoveItemResultSchema>;

/** A move pre-checked up to the point a confirmation decision is needed. */
interface MovePlan {
  pair: { source: string; destination: string };
  renamePath: string;
  validDest: string;
  isCaseOnlyRename: boolean;
  /** Whether the destination existed when planned (drives the TOCTOU guard). */
  destExistedOriginally: boolean;
  /** Destination exists and is not a self/case-only move → needs overwrite confirmation. */
  pending: boolean;
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
): Promise<PairPlanResult<MovePlan>> {
  let renamePath: string;
  let realPath: string;
  try {
    ({ renamePath, realPath } = await validateMoveSource(move.source, fs));
  } catch (error) {
    return { status: 'fail', failure: pairFailure(move, error) };
  }

  let validDest: string;
  try {
    validDest = await fs.pathGuard.validatePathForWrite(move.destination);
  } catch (error) {
    return { status: 'fail', failure: pairFailure(move, error) };
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

  const normalizedDest = IS_CASE_INSENSITIVE_FS ? resolvedDest.toLowerCase() : resolvedDest;
  const normalizedSource = IS_CASE_INSENSITIVE_FS
    ? (resolvedSource + sep).toLowerCase()
    : resolvedSource + sep;

  if (normalizedDest.startsWith(normalizedSource)) {
    return {
      status: 'fail',
      failure: pairFailure(
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
  const destExistedOriginally = !isCaseOnlyRename && (await destExists(fs, validDest, 'move'));

  const pending = !isCaseOnlyRename && destExistedOriginally;
  return {
    status: 'plan',
    plan: { pair: move, renamePath, validDest, isCaseOnlyRename, destExistedOriginally, pending },
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
  ctx: Pick<ToolCtx, 'fs' | 'signal' | 'inputResponses' | 'log'>,
  pendingSorted: readonly string[],
): Promise<PairExecResult<MoveItemResult>> {
  if (plan.pending) {
    const key = `confirm_${pendingSorted.indexOf(plan.validDest)}`;
    const choice = readAcceptedChoice(ctx.inputResponses, key);
    if (choice === 'skip') {
      return { skipped: plan.pair.destination };
    }
    if (choice !== 'overwrite') {
      throw new FsError(
        ErrorCode.CANCELLED,
        `Move cancelled: overwrite of "${plan.pair.destination}" was declined or missing`,
        plan.pair.destination,
      );
    }
  }

  // TOCTOU check before any mutation: a destination that did not exist when
  // planned but exists now was created during the confirmation gap.
  if (!plan.isCaseOnlyRename) {
    const existsNow = await destExists(ctx.fs, plan.validDest, 'move');
    if (existsNow && !plan.destExistedOriginally) {
      throw new FsError(
        ErrorCode.CANCELLED,
        `Move cancelled: destination "${plan.pair.destination}" was created during confirmation.`,
        plan.pair.destination,
      );
    }
  }

  await ctx.fs.mkdir(dirname(plan.validDest), { recursive: true });

  await performRenameWithFallback(plan.renamePath, plan.validDest, ctx.fs, plan.pair.source);
  ctx.log?.('info', `move: ${plan.pair.source} -> ${plan.pair.destination}`, 'move');
  return { value: { from: plan.renamePath, to: plan.validDest } };
}

/** A copy pre-checked up to the point a confirmation decision is needed. */
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
): Promise<PairExecResult<MoveItemResult>> {
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

  return { value: { from: plan.realSource, to: plan.validDest } };
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
  const outcome = args.copy
    ? await runOverPairs(args.moves, ctx, {
        op: 'copy',
        plan: (pair) => planCopy(pair, ctx.fs, args.overwrite),
        execute: (plan, pendingSorted) => executeCopy(plan, ctx, pendingSorted, args.overwrite),
      })
    : await runOverPairs(args.moves, ctx, {
        op: 'move',
        plan: (move) => planMove(move, ctx.fs),
        execute: (plan, pendingSorted) => executeMove(plan, ctx, pendingSorted),
      });
  if (isInputRequiredResult(outcome)) return outcome;

  const { results, skipped, failures } = outcome;

  return {
    moves: results,
    ...(failures.length > 0 ? { failures } : {}),
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}

function buildSummary(
  verb: 'move' | 'copy',
  results: readonly MoveItemResult[],
  failures: readonly MoveFailureItem[],
  skipped: readonly string[] = [],
): string {
  const successCount = results.length;
  const failCount = failures.length;
  if (failCount === 0 && skipped.length === 0 && successCount === 1) {
    const result = results[0];
    if (result) {
      return `${verb}: ${pathLabel(result.from)} → ${pathLabel(result.to)}`;
    }
  }
  // Name each pair. "move: 2 items" left the caller to open structuredContent
  // to learn which two, and a partial failure was unreadable without it.
  // Skipped destinations are an outcome the user chose, not a failure — name
  // them, or an all-skipped call reads as "copy: nothing".
  const tokens = [
    ...results.map((r) => `${pathLabel(r.from)} → ${pathLabel(r.to)}`),
    ...skipped.map((dest) => `${pathLabel(dest)} SKIPPED`),
  ];
  const parts = [`${verb}: ${joinRoster(tokens) || 'nothing'}`];
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
      throw error;
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
        const baseProblem = Problem.fromUnknown(
          copyOrRemoveError,
          ErrorCode.UNKNOWN,
          originalSource,
        );
        throw new FsError(
          baseProblem.code,
          `Cross-device move of ${originalSource}: copy succeeded but source removal failed (destination holds a copy): ${baseProblem.message}`,
          originalSource,
          undefined,
          copyOrRemoveError,
        );
      }
      throw copyOrRemoveError;
    }
  }
}

export const MOVE = defineTool({
  name: 'move',
  title: 'Move or Copy Files',
  description:
    'Move, rename, or copy files and directories to explicit destination paths (max 100 operations per call). ' +
    'Pass moves: [{ source, destination }] — there is no single-pair form. ' +
    'Parent directories are created automatically. Set copy=true to copy instead of move (sources are kept). ' +
    'An existing destination prompts the user to confirm the overwrite, so the call returns without moving ' +
    'anything until that confirmation comes back; copy=true with overwrite=true skips the prompt, move has no ' +
    'such bypass. Self-moves are silently skipped.',
  input: MoveInputSchema,
  output: MoveOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  progress: (args) => {
    const label = args.copy ? 'Copy' : 'Move';
    if (args.moves.length === 1) {
      const move = args.moves[0];
      return {
        label,
        subject: `${basename(move?.source ?? '')} → ${basename(move?.destination ?? '')}`,
      };
    }
    return { label, subject: `${String(args.moves.length)} files` };
  },
  defaultErrorCode: ErrorCode.UNKNOWN,
  accessPaths: (args) => args.moves.flatMap((m) => [m.source, m.destination]),
  run: async (args, ctx) => {
    const output = await handleMove(args, ctx);
    // input_required is a return value, not a completed call: surface it
    // verbatim so the executor short-circuits before building a CallToolResult.
    if (isInputRequiredResult(output)) return output;
    return {
      structured: output,
      text: buildSummary(
        args.copy ? 'copy' : 'move',
        output.moves,
        output.failures ?? [],
        output.skipped ?? [],
      ),
    };
  },
});
