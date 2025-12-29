import { PARALLEL_CONCURRENCY } from '../constants.js';

interface ParallelResult<R> {
  results: R[];
  errors: { index: number; error: Error }[];
}

interface ParallelState<T, R> {
  items: T[];
  processor: (item: T) => Promise<R>;
  concurrency: number;
  results: R[];
  errors: { index: number; error: Error }[];
  nextIndex: number;
  aborted: boolean;
  inFlight: Set<Promise<void>>;
}

function createAbortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

function createState<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number,
  signal?: AbortSignal
): ParallelState<T, R> {
  return {
    items,
    processor,
    concurrency,
    results: [],
    errors: [],
    nextIndex: 0,
    aborted: Boolean(signal?.aborted),
    inFlight: new Set<Promise<void>>(),
  };
}

function attachAbortListener<T, R>(
  state: ParallelState<T, R>,
  signal?: AbortSignal
): () => void {
  if (!signal || signal.aborted) return () => {};

  const onAbort = (): void => {
    state.aborted = true;
  };

  signal.addEventListener('abort', onAbort, { once: true });

  return (): void => {
    signal.removeEventListener('abort', onAbort);
  };
}

function createAbortPromise(signal?: AbortSignal): Promise<void> | undefined {
  if (!signal) return undefined;
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function canStartNext<T, R>(state: ParallelState<T, R>): boolean {
  return (
    !state.aborted &&
    state.inFlight.size < state.concurrency &&
    state.nextIndex < state.items.length
  );
}

function createTask<T, R>(
  item: T,
  index: number,
  state: ParallelState<T, R>
): Promise<void> {
  return (async (): Promise<void> => {
    try {
      const result = await state.processor(item);
      state.results.push(result);
    } catch (reason) {
      const error =
        reason instanceof Error ? reason : new Error(String(reason));
      state.errors.push({ index, error });
    }
  })();
}

function queueNextTask<T, R>(state: ParallelState<T, R>): void {
  const index = state.nextIndex;
  state.nextIndex += 1;
  const item = state.items[index];
  if (item === undefined) return;

  const task = createTask(item, index, state);
  state.inFlight.add(task);
  void task.finally(() => {
    state.inFlight.delete(task);
  });
}

function startNextTasks<T, R>(state: ParallelState<T, R>): void {
  while (canStartNext(state)) {
    queueNextTask(state);
  }
}

async function drainTasks<T, R>(
  state: ParallelState<T, R>,
  abortPromise?: Promise<void>
): Promise<void> {
  startNextTasks(state);
  while (state.inFlight.size > 0) {
    if (state.aborted) return;
    const raceTargets = abortPromise
      ? [...state.inFlight, abortPromise]
      : [...state.inFlight];
    await Promise.race(raceTargets);
    startNextTasks(state);
  }
}

export async function processInParallel<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number = PARALLEL_CONCURRENCY,
  signal?: AbortSignal
): Promise<ParallelResult<R>> {
  const state = createState(items, processor, concurrency, signal);
  const abortPromise = createAbortPromise(signal);

  if (items.length === 0) {
    return { results: state.results, errors: state.errors };
  }

  const detachAbort = attachAbortListener(state, signal);

  try {
    await drainTasks(state, abortPromise);
  } finally {
    detachAbort();
  }

  if (state.aborted) {
    throw createAbortError();
  }

  return { results: state.results, errors: state.errors };
}
