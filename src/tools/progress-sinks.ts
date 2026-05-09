import type { ProgressEvent, ProgressSink } from '../lib/progress-session.js';

/**
 * A progress sink that forwards events to an MCP progress notification callback.
 * Implements 100% display normalization for 'complete' and 'fail' events.
 */
export class McpProgressSink implements ProgressSink {
  constructor(
    public readonly name: string,
    private readonly onProgress: (data: { progress: number; total: number }) => void
  ) {}

  emit(event: ProgressEvent): void {
    if (event.kind === 'status') {
      return;
    }

    let { current, total } = event;

    if (event.kind === 'complete' || event.kind === 'fail') {
      // 100% display normalization: Ensure display hits 100% on terminal events.
      // Math.max(current, total ?? current, 1) ensures we don't send 0/0 and that progress >= total.
      const finalValue = Math.max(current, total ?? current, 1);
      current = finalValue;
      total = finalValue;
    }

    if (total !== undefined) {
      this.onProgress({
        progress: current,
        total,
      });
    }
  }
}
