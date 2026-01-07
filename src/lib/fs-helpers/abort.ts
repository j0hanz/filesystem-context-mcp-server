/**
 * Create an AbortError with the specified message.
 */
export function createAbortError(message = 'Operation aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/**
 * Assert that the signal is not aborted, throwing if it is.
 *
 * @throws The signal's reason if aborted, or an AbortError
 */
export function assertNotAborted(signal?: AbortSignal, message?: string): void {
  if (!signal?.aborted) return;
  const { reason } = signal as { reason?: unknown };
  if (reason instanceof Error) {
    throw reason;
  }
  throw createAbortError(message);
}

function getAbortError(signal: AbortSignal, message?: string): Error {
  const { reason } = signal as { reason?: unknown };
  if (reason instanceof Error) {
    return reason;
  }
  return createAbortError(message);
}

/**
 * Wrap a promise with abort signal support.
 *
 * If the signal is already aborted, throws immediately.
 * If the signal aborts during the promise, rejects with the abort reason.
 *
 * @param promise - The promise to wrap
 * @param signal - Optional abort signal
 * @returns Promise that rejects on abort
 */
export function withAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    throw getAbortError(signal);
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(getAbortError(signal));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    promise
      .then((value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      })
      .catch((error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

/**
 * Create a combined abort signal with optional timeout.
 *
 * Combines a base signal (if provided) with a timeout signal.
 * The cleanup function must be called to prevent timer leaks.
 *
 * Uses AbortSignal.any() when available (Node.js 20+) for cleaner
 * signal combination.
 *
 * @param baseSignal - Optional base signal to combine with timeout
 * @param timeoutMs - Optional timeout in milliseconds
 * @returns Combined signal and cleanup function
 */
export function createTimedAbortSignal(
  baseSignal: AbortSignal | undefined,
  timeoutMs?: number
): { signal: AbortSignal; cleanup: () => void } {
  // Fast path: no timeout and no base signal
  if (!baseSignal && !timeoutMs) {
    const controller = new AbortController();
    return { signal: controller.signal, cleanup: () => {} };
  }

  // Fast path: no timeout, just forward the base signal
  if (!timeoutMs && baseSignal) {
    return { signal: baseSignal, cleanup: () => {} };
  }

  // Use AbortSignal.any() if available (Node.js 20+) for cleaner combination
  if (typeof AbortSignal.any === 'function' && baseSignal && timeoutMs) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([baseSignal, timeoutSignal]);
    // AbortSignal.timeout handles its own cleanup, no manual cleanup needed
    return { signal: combined, cleanup: () => {} };
  }

  // Fallback: manual signal combination
  const controller = new AbortController();

  const forwardAbort = (): void => {
    const reason =
      baseSignal?.reason instanceof Error ? baseSignal.reason : undefined;
    controller.abort(reason);
  };

  if (baseSignal) {
    if (baseSignal.aborted) {
      forwardAbort();
    } else {
      baseSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  const timeoutId =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
      ? setTimeout(() => {
          controller.abort(createAbortError('Operation timed out'));
        }, timeoutMs)
      : undefined;

  const cleanup = (): void => {
    if (baseSignal) {
      baseSignal.removeEventListener('abort', forwardAbort);
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  };

  return { signal: controller.signal, cleanup };
}
