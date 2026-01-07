function createAbortError(message = 'Operation aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

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
export function createTimedAbortSignal(
  baseSignal: AbortSignal | undefined,
  timeoutMs?: number
): { signal: AbortSignal; cleanup: () => void } {
  // Fast path: no timeout and no base signal
  if (!baseSignal && !timeoutMs) {
    return createNoopSignal();
  }

  // Fast path: no timeout, just forward the base signal
  if (!timeoutMs && baseSignal) {
    return createForwardedSignal(baseSignal);
  }

  // Use AbortSignal.any() if available (Node.js 20+) for cleaner combination
  if (typeof timeoutMs === 'number' && shouldUseAbortAny(baseSignal)) {
    return createAnySignal(baseSignal, timeoutMs);
  }

  // Fallback: manual signal combination
  return createManualSignal(baseSignal, timeoutMs);
}

function createNoopSignal(): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  return { signal: controller.signal, cleanup: () => {} };
}

function createForwardedSignal(baseSignal: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  return { signal: baseSignal, cleanup: () => {} };
}

function shouldUseAbortAny(
  baseSignal: AbortSignal | undefined
): baseSignal is AbortSignal {
  return typeof AbortSignal.any === 'function' && baseSignal !== undefined;
}

function createAnySignal(
  baseSignal: AbortSignal,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([baseSignal, timeoutSignal]);
  // AbortSignal.timeout handles its own cleanup, no manual cleanup needed
  return { signal: combined, cleanup: () => {} };
}

function createManualSignal(
  baseSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
): { signal: AbortSignal; cleanup: () => void } {
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

  const timeoutId = createTimeout(controller, timeoutMs);

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

function createTimeout(
  controller: AbortController,
  timeoutMs: number | undefined
): ReturnType<typeof setTimeout> | undefined {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return undefined;
  }

  return setTimeout(() => {
    controller.abort(createAbortError('Operation timed out'));
  }, timeoutMs);
}
