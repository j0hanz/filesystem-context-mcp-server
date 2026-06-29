import { normalizeUnknownError } from './errors.js';
import { PARALLEL_CONCURRENCY } from './util.js';

const UNFILLED = Symbol('UNFILLED');
type Unfilled = typeof UNFILLED;

export interface ParallelResult<R> {
  results: { index: number; value: R }[];
  errors: { index: number; error: Error }[];
}

function checkParallelAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
}

function assertPositiveIntegerOption(name: string, value: unknown): void {
  if (value === undefined) return;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function normalizeConcurrency(concurrency: number): number {
  assertPositiveIntegerOption('concurrency', concurrency);
  return concurrency;
}

export async function processInParallel<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number = PARALLEL_CONCURRENCY,
  signal?: AbortSignal,
): Promise<ParallelResult<R>> {
  const itemCount = items.length;
  if (itemCount === 0) return { results: [], errors: [] };
  const effectiveConcurrency = normalizeConcurrency(concurrency);

  const resultSlots: (R | Unfilled)[] = new Array<R | Unfilled>(itemCount);
  const errors: { index: number; error: Error }[] = [];

  checkParallelAbort(signal);

  let nextIndex = 0;
  resultSlots.fill(UNFILLED);

  const next = async (): Promise<void> => {
    while (nextIndex < itemCount) {
      checkParallelAbort(signal);

      const index = nextIndex;
      nextIndex += 1;
      const item = items[index] as T;

      try {
        const result = await processor(item);
        checkParallelAbort(signal);
        resultSlots[index] = result;
      } catch (error) {
        errors.push({
          index,
          error: normalizeUnknownError(error),
        });
      }
    }
  };

  const workerCount = Math.min(itemCount, effectiveConcurrency);
  const workers: Promise<void>[] = new Array<Promise<void>>(workerCount);
  for (let index = 0; index < workerCount; index += 1) {
    workers[index] = next();
  }

  await Promise.allSettled(workers);
  checkParallelAbort(signal);

  const results: { index: number; value: R }[] = [];
  resultSlots.forEach((slot, index) => {
    if (slot !== UNFILLED) {
      results.push({ index, value: slot });
    }
  });
  return { results, errors };
}

export async function runWorkerOr<T>(
  _name: string,
  _payload: unknown,
  _payloadBytes: number,
  _opts: unknown,
  inline: () => Promise<T>,
): Promise<T> {
  return inline();
}

export async function shutdownWorkerPool(): Promise<void> {
  // no-op, worker pool removed
}

function createAbortError(message = 'Operation aborted'): Error {
  return new DOMException(message, 'AbortError');
}

const SHARED_NOOP_SIGNAL = new AbortController().signal;

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

export function createTimedAbortSignal(
  baseSignal: AbortSignal | undefined,
  timeoutMs?: number,
): { signal: AbortSignal; cleanup: () => void } {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)) {
    if (baseSignal?.aborted) {
      const controller = new AbortController();
      controller.abort(baseSignal.reason);
      return { signal: controller.signal, cleanup: () => undefined };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
    }, timeoutMs);
    timer.unref();

    let onBaseAbort: (() => void) | undefined;
    if (baseSignal) {
      if (baseSignal.aborted) {
        controller.abort(baseSignal.reason);
      } else {
        onBaseAbort = () => {
          controller.abort(baseSignal.reason);
        };
        baseSignal.addEventListener('abort', onBaseAbort, { once: true });
      }
    }

    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timer);
        if (baseSignal && onBaseAbort) {
          baseSignal.removeEventListener('abort', onBaseAbort);
        }
      },
    };
  }

  if (baseSignal) {
    return { signal: baseSignal, cleanup: () => undefined };
  }

  return { signal: SHARED_NOOP_SIGNAL, cleanup: () => undefined };
}

export async function withTimedAbortSignal<T>(
  baseSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const { signal, cleanup } = createTimedAbortSignal(baseSignal, timeoutMs);
  try {
    return await run(signal);
  } finally {
    cleanup();
  }
}
