import { createTimedAbortSignal } from '../../lib/fs-helpers/abort.js';

export async function withTimedSignal<T>(
  signal: AbortSignal,
  timeoutMs: number | undefined,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const { signal: timedSignal, cleanup } = createTimedAbortSignal(
    signal,
    timeoutMs
  );
  try {
    return await run(timedSignal);
  } finally {
    cleanup();
  }
}
