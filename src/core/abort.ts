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

export function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
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
      },
    );
  });
}

export function createTimedAbortSignal(
  baseSignal: AbortSignal | undefined,
  timeoutMs?: number,
): { signal: AbortSignal; cleanup: () => void } {
  if (isFiniteNumber(timeoutMs)) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
    }, timeoutMs);
    timer.unref();

    const combined = baseSignal
      ? AbortSignal.any([baseSignal, controller.signal])
      : controller.signal;

    return {
      signal: combined,
      cleanup: () => {
        clearTimeout(timer);
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
