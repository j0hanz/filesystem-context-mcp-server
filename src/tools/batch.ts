import type { InputRequiredResult } from '@modelcontextprotocol/server';

import { processInParallel } from '../core/concurrency.js';
import { ErrorCode, FsError, Problem, rethrowIfAborted } from '../core/errors.js';
import { choiceInput, pendingRoundTrip } from '../core/input-required.js';
import { IS_CASE_INSENSITIVE_FS } from '../core/path.js';
import type { PairFailureItem } from '../core/schema.js';
import { PARALLEL_CONCURRENCY } from '../core/util.js';
import type { ToolCtx } from './define.js';

interface PerPathError {
  code: ErrorCode;
  message: string;
  path?: string;
  suggestion?: string;
}

export type PerPathResult<T> = { path: string; value: T } | { path: string; error: PerPathError };

export interface BatchResult<T> {
  results: PerPathResult<T>[];
  summary: { total: number; succeeded: number; failed: number };
}

type BatchInput<TOverride> =
  { path: string } | { paths: string[] } | { files: ({ path: string } & TOverride)[] };

interface RunOverPathsOptions {
  defaultErrorCode?: ErrorCode;
  concurrency?: number;
}

function normalizeBatchItems<TOverride>(
  args: BatchInput<TOverride>,
): { path: string; override?: TOverride }[] {
  if ('path' in args) return [{ path: args.path }];
  if ('paths' in args) return args.paths.map((path) => ({ path }));
  if ('files' in args)
    return args.files.map(({ path, ...rest }) => ({
      path,
      override: rest as TOverride,
    }));
  return [];
}

export async function runOverPaths<TOverride, TPerPath>(
  args: BatchInput<TOverride>,
  ctx: ToolCtx,
  perPath: (item: { path: string; override?: TOverride }, ctx: ToolCtx) => Promise<TPerPath>,
  options?: RunOverPathsOptions,
): Promise<BatchResult<TPerPath>> {
  const items = normalizeBatchItems(args);
  if (items.length === 0) {
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      "runOverPaths: at least one of 'path', 'paths', or 'files' must be provided",
    );
  }

  const defaultErrorCode = options?.defaultErrorCode ?? ErrorCode.UNKNOWN;
  const concurrency = options?.concurrency ?? PARALLEL_CONCURRENCY;

  const total = items.length;
  let completed = 0;
  const results: PerPathResult<TPerPath>[] = new Array<PerPathResult<TPerPath>>(total);

  const tick = (): void => {
    completed += 1;
    ctx.onProgress?.({ current: completed, total });
  };

  await processInParallel<
    { item: { path: string; override?: TOverride }; index: number },
    undefined
  >(
    items.map((item, index) => ({ item, index })),
    async ({ item, index }) => {
      try {
        const value = await perPath(item, ctx);
        results[index] = { path: item.path, value };
      } catch (error: unknown) {
        results[index] = {
          path: item.path,
          error: Problem.toPerFileError(error, defaultErrorCode, item.path),
        };
      } finally {
        tick();
      }
      return undefined;
    },
    concurrency,
    ctx.signal,
  );

  let succeeded = 0;
  for (const result of results) {
    if (!('error' in result)) succeeded += 1;
  }

  return {
    results,
    summary: { total, succeeded, failed: total - succeeded },
  };
}

/** The minimum a pair plan must expose for the shared driver to route it. */
export interface PairPlan {
  readonly pair: { source: string; destination: string };
  readonly validDest: string;
  readonly pending: boolean;
}

export type PairPlanResult<TPlan extends PairPlan> =
  | { status: 'fail'; failure: PairFailureItem }
  | { status: 'noop' }
  | { status: 'plan'; plan: TPlan };

/** A discriminated union, so the fold below narrows without a generic cast. */
export type PairExecResult<TResult> = { readonly skipped: string } | { readonly value: TResult };

export interface PairBatchOutcome<TResult> {
  results: TResult[];
  skipped: string[];
  failures: PairFailureItem[];
}

export function pairFailure(
  pair: { source: string; destination: string },
  error: unknown,
): PairFailureItem {
  return {
    source: pair.source,
    destination: pair.destination,
    error: Problem.toPerFileError(error, ErrorCode.UNKNOWN, pair.source),
  };
}

interface RunOverPairsOptions<TItem, TPlan extends PairPlan, TResult> {
  readonly op: 'copy' | 'move';
  readonly plan: (item: TItem) => Promise<PairPlanResult<TPlan>>;
  readonly execute: (
    plan: TPlan,
    pendingSorted: readonly string[],
  ) => Promise<PairExecResult<TResult>>;
}

/**
 * The source→destination sibling of `runOverPaths`: plan every pair, fail closed
 * on a duplicated destination, round-trip the overwrite confirmations as one
 * set, then execute what survived in parallel. `copy` and `move` differ only in
 * their `plan` and `execute` callbacks.
 */
export async function runOverPairs<TItem, TPlan extends PairPlan, TResult>(
  items: readonly TItem[],
  ctx: ToolCtx,
  opts: RunOverPairsOptions<TItem, TPlan, TResult>,
): Promise<PairBatchOutcome<TResult> | InputRequiredResult> {
  const verb = opts.op === 'copy' ? 'Copy' : 'Move';

  const { results: planned, errors: planErrors } = await processInParallel(
    items,
    opts.plan,
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );
  // plan callbacks are fail-closed (they return { status: 'fail' }, never
  // throw), so planErrors should always be empty. Surface the first rather
  // than silently dropping the item if a future plan callback violates that.
  const firstPlanError = planErrors[0];
  if (firstPlanError) throw firstPlanError.error;

  const failures: PairFailureItem[] = [];
  const candidates: TPlan[] = [];
  for (const { value } of planned) {
    if (value.status === 'fail') failures.push(value.failure);
    else if (value.status === 'plan') candidates.push(value.plan);
    // 'noop' (self-copy / self-move) is silently skipped.
  }

  // Two sources targeting the same destination in one batch would otherwise
  // collapse to a single shared overwrite confirmation and let the second
  // one silently clobber the first's freshly-written content. Fail closed:
  // only the first plan per destination proceeds; later ones targeting the
  // same destination are reported as a per-item failure.
  const seenDest = new Set<string>();
  const ready: TPlan[] = [];
  for (const plan of candidates) {
    const destKey = IS_CASE_INSENSITIVE_FS ? plan.validDest.toLowerCase() : plan.validDest;
    if (seenDest.has(destKey)) {
      failures.push(
        pairFailure(
          plan.pair,
          new FsError(
            ErrorCode.INVALID_INPUT,
            `${verb} cancelled: another entry in this batch already targets destination "${plan.pair.destination}"`,
            plan.pair.destination,
          ),
        ),
      );
      continue;
    }
    seenDest.add(destKey);
    ready.push(plan);
  }

  const pendingSorted = ready
    .filter((p) => p.pending)
    .map((p) => p.validDest)
    .sort();
  if (pendingSorted.length > 0) {
    // Round 1 returns input_required; a retry whose verified state does not
    // bind this overwrite set throws (R9) via `pendingRoundTrip`.
    const round = await pendingRoundTrip({
      op: opts.op,
      pending: pendingSorted,
      requestState: ctx.requestState,
      buildInputs: (dests) =>
        dests.map((dest, i) =>
          choiceInput(
            `confirm_${i}`,
            opts.op === 'move'
              ? `"${dest}" already exists. Overwrite it?`
              : `Destination "${dest}" already exists. Overwrite it?`,
            [
              { value: 'overwrite', title: 'Overwrite' },
              { value: 'skip', title: 'Skip' },
            ],
          ),
        ),
    });
    if (round !== undefined) return round;
  }

  const { results: execResults, errors: execErrors } = await processInParallel(
    ready,
    (plan) => opts.execute(plan, pendingSorted),
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );

  for (const { error, index } of execErrors) {
    rethrowIfAborted(error);
    const plan = ready[index];
    if (plan) failures.push(pairFailure(plan.pair, error));
  }

  const results: TResult[] = [];
  const skipped: string[] = [];
  for (const { value } of execResults) {
    if ('skipped' in value) skipped.push(value.skipped);
    else results.push(value.value);
  }

  return { results, skipped, failures };
}
