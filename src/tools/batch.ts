import { processInParallel } from '../core/concurrency.js';
import { ErrorCode, FsError, Problem } from '../core/errors.js';
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
