import { PARALLEL_CONCURRENCY } from './constants.js';
import { normalizeUnknownError } from './errors.js';

const UNFILLED = Symbol('UNFILLED');
type Unfilled = typeof UNFILLED;

export interface ParallelResult<R> {
  results: R[];
  errors: { index: number; error: Error }[];
}

function createParallelAbortError(): Error {
  return new DOMException('Operation aborted', 'AbortError');
}

function assertPositiveSafeIntegerOption(name: string, value: unknown): void {
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
  assertPositiveSafeIntegerOption('concurrency', concurrency);
  return concurrency;
}

export async function processInParallel<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number = PARALLEL_CONCURRENCY,
  signal?: AbortSignal
): Promise<ParallelResult<R>> {
  const itemCount = items.length;
  if (itemCount === 0) return { results: [], errors: [] };
  const effectiveConcurrency = normalizeConcurrency(concurrency);

  // Pre-allocate slots by index to guarantee input-order output.
  // Use UNFILLED sentinel to distinguish "not yet filled" from "filled with undefined".
  const resultSlots: (R | Unfilled)[] = new Array<R | Unfilled>(itemCount);
  const errors: { index: number; error: Error }[] = [];

  if (signal?.aborted) throw createParallelAbortError();

  let nextIndex = 0;

  resultSlots.fill(UNFILLED);

  const next = async (): Promise<void> => {
    while (nextIndex < itemCount) {
      if (signal?.aborted) throw createParallelAbortError();

      const index = nextIndex;
      nextIndex += 1;

      // Safe: `index < itemCount === items.length`, so `items[index]` is defined.
      // Cast bypasses `noUncheckedIndexedAccess` widening to `T | undefined`.
      const item = items[index] as T;

      try {
        const result = await processor(item);
        if (signal?.aborted) throw createParallelAbortError();
        resultSlots[index] = result;
      } catch (error) {
        if (signal?.aborted) throw createParallelAbortError();

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

  if (signal?.aborted) throw createParallelAbortError();

  const results: R[] = [];
  for (const slot of resultSlots) {
    if (slot !== UNFILLED) {
      results.push(slot);
    }
  }
  return { results, errors };
}
