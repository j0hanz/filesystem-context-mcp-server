import { PARALLEL_CONCURRENCY } from '../constants.js';

interface ParallelResult<R> {
  results: R[];
  errors: { index: number; error: Error }[];
}

function createAbortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

export async function processInParallel<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number = PARALLEL_CONCURRENCY,
  signal?: AbortSignal
): Promise<ParallelResult<R>> {
  const results: R[] = [];
  const errors: { index: number; error: Error }[] = [];

  if (items.length === 0) {
    return { results, errors };
  }

  let nextIndex = 0;
  let aborted = Boolean(signal?.aborted);
  const inFlight = new Set<Promise<void>>();

  const onAbort = (): void => {
    aborted = true;
  };

  if (signal && !signal.aborted) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const startNext = (): void => {
    while (
      !aborted &&
      inFlight.size < concurrency &&
      nextIndex < items.length
    ) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) break;
      const task = (async (): Promise<void> => {
        try {
          const result = await processor(item);
          results.push(result);
        } catch (reason) {
          const error =
            reason instanceof Error ? reason : new Error(String(reason));
          errors.push({ index, error });
        }
      })();
      inFlight.add(task);
      void task.finally(() => {
        inFlight.delete(task);
      });
    }
  };

  startNext();
  while (inFlight.size > 0) {
    await Promise.race(inFlight);
    startNext();
  }

  if (signal) {
    signal.removeEventListener('abort', onAbort);
  }

  if (aborted) {
    throw createAbortError();
  }

  return { results, errors };
}
