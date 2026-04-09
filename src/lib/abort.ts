import { normalizeUnknownError } from './errors.js';

function createAbortError(message = 'Operation aborted'): Error {
  return new DOMException(message, 'AbortError');
}

const SHARED_NOOP_SIGNAL = new AbortController().signal;

function normalizeAbortReason(reason: unknown, message?: string): Error {
  if (reason instanceof Error) return reason;
  return createAbortError(message);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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

export function withAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
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
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(normalizeUnknownError(error));
      }
    );
  });
}

export function createTimedAbortSignal(
  baseSignal: AbortSignal | undefined,
  timeoutMs?: number
): { signal: AbortSignal; cleanup: () => void } {
  const timeoutSignal = isFiniteNumber(timeoutMs)
    ? AbortSignal.timeout(timeoutMs)
    : undefined;

  if (baseSignal && timeoutSignal) {
    return {
      signal: AbortSignal.any([baseSignal, timeoutSignal]),
      cleanup: () => {},
    };
  }

  if (baseSignal) {
    return { signal: baseSignal, cleanup: () => {} };
  }

  if (timeoutSignal) {
    return { signal: timeoutSignal, cleanup: () => {} };
  }

  return { signal: SHARED_NOOP_SIGNAL, cleanup: () => {} };
}

export async function withTimedAbortSignal<T>(
  baseSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const { signal, cleanup } = createTimedAbortSignal(baseSignal, timeoutMs);
  try {
    return await run(signal);
  } finally {
    cleanup();
  }
}
