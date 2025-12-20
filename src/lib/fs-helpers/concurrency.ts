import { PARALLEL_CONCURRENCY } from '../constants.js';

interface ParallelResult<R> {
  results: R[];
  errors: { index: number; error: Error }[];
}

interface WorkQueueState<T> {
  queue: T[];
  inFlight: number;
  aborted: boolean;
  doneResolve?: () => void;
}

function createDonePromise(state: WorkQueueState<unknown>): Promise<void> {
  return new Promise<void>((resolve) => {
    state.doneResolve = resolve;
  });
}

function resolveIfDone<T>(state: WorkQueueState<T>): void {
  if (state.inFlight !== 0) return;
  if (state.queue.length === 0 || state.aborted) {
    state.doneResolve?.();
  }
}

function createAbortHandler<T>(state: WorkQueueState<T>): () => void {
  return (): void => {
    state.aborted = true;
    resolveIfDone(state);
  };
}

function enqueueItem<T>(state: WorkQueueState<T>, item: T): void {
  if (state.aborted) return;
  state.queue.push(item);
}

function handleWorkerCompletion<T>(state: WorkQueueState<T>): void {
  state.inFlight--;
  resolveIfDone(state);
}

function startWorker<T>(
  state: WorkQueueState<T>,
  item: T,
  worker: (item: T, enqueue: (item: T) => void) => Promise<void>,
  maybeStartNext: () => void
): void {
  state.inFlight++;

  try {
    void worker(item, (next) => {
      enqueueItem(state, next);
      maybeStartNext();
    })
      .catch((error: unknown) => {
        console.error(
          '[runWorkQueue] Worker error:',
          error instanceof Error ? error.message : String(error)
        );
      })
      .finally(() => {
        handleWorkerCompletion(state);
        if (!state.aborted) {
          maybeStartNext();
        }
      });
  } catch (error) {
    console.error(
      '[runWorkQueue] Worker synchronous error:',
      error instanceof Error ? error.message : String(error)
    );
    handleWorkerCompletion(state);
    if (!state.aborted) {
      maybeStartNext();
    }
  }
}

function createQueueProcessor<T>(
  state: WorkQueueState<T>,
  worker: (item: T, enqueue: (item: T) => void) => Promise<void>,
  concurrency: number
): () => void {
  const maybeStartNext = (): void => {
    if (state.aborted) return;

    while (state.inFlight < concurrency && state.queue.length > 0) {
      const next = state.queue.shift();
      if (next === undefined) break;
      startWorker(state, next, worker, maybeStartNext);
    }
  };

  return maybeStartNext;
}

export async function runWorkQueue<T>(
  initialItems: T[],
  worker: (item: T, enqueue: (item: T) => void) => Promise<void>,
  concurrency: number,
  signal?: AbortSignal
): Promise<void> {
  const state: WorkQueueState<T> = {
    queue: [...initialItems],
    inFlight: 0,
    aborted: false,
  };
  const donePromise = createDonePromise(state);
  const onAbort = createAbortHandler(state);

  signal?.addEventListener('abort', onAbort, { once: true });

  const maybeStartNext = createQueueProcessor(state, worker, concurrency);
  maybeStartNext();
  resolveIfDone(state);

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
