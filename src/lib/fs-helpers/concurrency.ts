import { PARALLEL_CONCURRENCY } from '../constants.js';

interface ParallelResult<R> {
  results: R[];
  errors: { index: number; error: Error }[];
}

export async function runWorkQueue<T>(
  initialItems: T[],
  worker: (item: T, enqueue: (item: T) => void) => Promise<void>,
  concurrency: number,
  signal?: AbortSignal
): Promise<void> {
  const queue: T[] = [...initialItems];
  let inFlight = 0;
  let aborted = false;
  let doneResolve: (() => void) | undefined;
  const donePromise = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });

  const onAbort = (): void => {
    aborted = true;
    if (inFlight === 0) {
      doneResolve?.();
    }
  };

  signal?.addEventListener('abort', onAbort, { once: true });

  const maybeStartNext = (): void => {
    if (aborted) return;

    while (inFlight < concurrency && queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;

      inFlight++;
      void worker(next, (item: T) => {
        if (!aborted) {
          queue.push(item);
          maybeStartNext();
        }
      })
        .catch((error: unknown) => {
          console.error(
            '[runWorkQueue] Worker error:',
            error instanceof Error ? error.message : String(error)
          );
        })
        .finally(() => {
          inFlight--;
          if (inFlight === 0 && (queue.length === 0 || aborted)) {
            doneResolve?.();
          } else if (!aborted) {
            maybeStartNext();
          }
        });
    }
  };

  maybeStartNext();

  if (inFlight === 0 && queue.length === 0) {
    doneResolve?.();
  }

  try {
    await donePromise;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function processInParallel<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number = PARALLEL_CONCURRENCY
): Promise<ParallelResult<R>> {
  const results: R[] = [];
  const errors: { index: number; error: Error }[] = [];

  if (items.length === 0) {
    return { results, errors };
  }

  await runWorkQueue(
    items.map((item, index) => ({ item, index })),
    async ({ item, index }) => {
      try {
        const result = await processor(item);
        results.push(result);
      } catch (reason) {
        const error =
          reason instanceof Error ? reason : new Error(String(reason));
        errors.push({ index, error });
      }
    },
    concurrency
  );

  return { results, errors };
}
