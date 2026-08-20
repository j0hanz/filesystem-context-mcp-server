import { normalizeUnknownError } from './errors.js';
import { PARALLEL_CONCURRENCY } from './util.js';

export interface ParallelResult<R> {
  results: { index: number; value: R }[];
  errors: { index: number; error: Error }[];
}

function checkParallelAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
}

export async function processInParallel<T, R>(
  items: readonly T[],
  processor: (item: T) => Promise<R>,
  concurrency: number = PARALLEL_CONCURRENCY,
  signal?: AbortSignal,
): Promise<ParallelResult<R>> {
  const itemCount = items.length;
  if (itemCount === 0) return { results: [], errors: [] };

  const results: { index: number; value: R }[] = [];
  const errors: { index: number; error: Error }[] = [];

  checkParallelAbort(signal);

  let nextIndex = 0;

  const next = async (): Promise<void> => {
    while (nextIndex < itemCount) {
      checkParallelAbort(signal);

      const index = nextIndex;
      nextIndex += 1;
      const item = items[index] as T;

      try {
        const value = await processor(item);
        checkParallelAbort(signal);
        results.push({ index, value });
      } catch (error) {
        errors.push({
          index,
          error: normalizeUnknownError(error),
        });
      }
    }
  };

  const workerCount = Math.min(itemCount, concurrency);
  const workers: Promise<void>[] = new Array<Promise<void>>(workerCount);
  for (let index = 0; index < workerCount; index += 1) {
    workers[index] = next();
  }

  await Promise.allSettled(workers);
  checkParallelAbort(signal);

  results.sort((left, right) => left.index - right.index);
  return { results, errors };
}

function createAbortError(message = 'Operation aborted'): Error {
  return new DOMException(message, 'AbortError');
}

function normalizeAbortReason(reason: unknown, message?: string): Error {
  if (reason instanceof Error) return reason;
  return createAbortError(message);
}

export function assertNotAborted(signal?: AbortSignal, message?: string): void {
  if (!signal) return;
  try {
    signal.throwIfAborted();
  } catch (reason) {
    throw normalizeAbortReason(reason, message);
  }
}

function getAbortError(signal: AbortSignal, message?: string): Error {
  try {
    signal.throwIfAborted();
  } catch (reason) {
    return normalizeAbortReason(reason, message);
  }
  return createAbortError(message);
}

export function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(getAbortError(signal));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        reject(normalizeUnknownError(error));
      },
    );
  });
}

/**
 * `baseSignal` combined with a deadline. `AbortSignal.timeout`'s timer does not
 * hold the event loop open and is collected with the signal, so there is
 * nothing for callers to clean up.
 */
export function timedSignal(baseSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return baseSignal ? AbortSignal.any([baseSignal, deadline]) : deadline;
}
