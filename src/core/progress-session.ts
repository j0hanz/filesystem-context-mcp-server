import { Logger } from './logger.js';

export type ProgressEvent =
  | { kind: 'tick'; current: number; total?: number; message: string }
  | { kind: 'status'; message: string }
  | { kind: 'complete'; current: number; total?: number; message: string }
  | {
      kind: 'fail';
      current: number;
      total?: number;
      message: string;
      error: unknown;
    };

export interface ProgressSink {
  readonly name: string;
  emit(event: ProgressEvent): Promise<void> | void;
}

interface ProgressSessionOptions {
  label: string;
  total?: number;
  sinks: ProgressSink[];
  /** Clock injection for deterministic rate-limit tests. Defaults to Date.now. */
  now?: () => number;
  /** Override the rate limit window. Default: 50ms. */
  rateLimitMs?: number;
  /** If true, rate limit window increases after 5 seconds of execution. */
  dynamicRateLimit?: boolean;
}

const DEFAULT_RATE_LIMIT_MS = 50;

export class ProgressSession {
  readonly #label: string;
  readonly #total: number | undefined;
  readonly #sinks: ProgressSink[];
  readonly #now: () => number;
  readonly #rateLimitMs: number;
  readonly #dynamicRateLimit: boolean;
  readonly #startTime: number;

  #cursor = 0;
  #lastSentMs = 0;
  #done = false;

  constructor(opts: ProgressSessionOptions) {
    this.#label = opts.label;
    this.#total = opts.total;
    this.#sinks = opts.sinks;
    this.#now = opts.now ?? Date.now;
    this.#rateLimitMs = opts.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
    this.#dynamicRateLimit = opts.dynamicRateLimit ?? false;

    const now = this.#now();
    this.#startTime = now;
    this.#lastSentMs = now - this.#rateLimitMs;

    // Synthetic start tick — preserves today's "fire 0/total at session creation" wire behavior.
    this.#dispatch({
      kind: 'tick',
      current: 0,
      ...(this.#total !== undefined ? { total: this.#total } : {}),
      message: this.#label,
    });
  }

  get current(): number {
    return this.#cursor;
  }

  step(message: string): void {
    if (this.#done) return;
    this.#cursor += 1;
    this.#dispatch({
      kind: 'tick',
      current: this.#cursor,
      ...(this.#total !== undefined ? { total: this.#total } : {}),
      message,
    });
  }

  set(input: { current: number; total?: number; message?: string }): void {
    if (this.#done) return;
    if (input.current > this.#cursor) {
      this.#cursor = input.current;
    }
    const total = input.total ?? this.#total;
    this.#dispatch({
      kind: 'tick',
      current: this.#cursor,
      ...(total !== undefined ? { total } : {}),
      message: input.message ?? this.#label,
    });
  }

  status(message: string): void {
    if (this.#done) return;
    this.#dispatch({
      kind: 'status',
      message,
    });
  }

  complete(message: string): void {
    if (this.#done) return;
    this.#done = true;
    this.#dispatch({
      kind: 'complete',
      current: this.#cursor,
      ...(this.#total !== undefined ? { total: this.#total } : {}),
      message,
    });
  }

  fail(error: unknown, message?: string): void {
    if (this.#done) return;
    this.#done = true;
    this.#dispatch({
      kind: 'fail',
      current: this.#cursor,
      ...(this.#total !== undefined ? { total: this.#total } : {}),
      message: message ?? this.#label,
      error,
    });
  }

  #dispatch(event: ProgressEvent): void {
    if (this.#shouldRateLimit(event)) {
      return;
    }

    if (event.kind !== 'status') {
      this.#lastSentMs = this.#now();
    }

    for (const sink of this.#sinks) {
      this.#emitGuarded(sink, event);
    }
  }

  #shouldRateLimit(event: ProgressEvent): boolean {
    if (event.kind !== 'tick') {
      return false;
    }

    const now = this.#now();
    const effectiveRateLimit =
      this.#dynamicRateLimit && now - this.#startTime > 5000
        ? Math.max(this.#rateLimitMs, 250)
        : this.#rateLimitMs;

    const elapsed = now - this.#lastSentMs;
    return elapsed < effectiveRateLimit;
  }

  #emitGuarded(sink: ProgressSink, event: ProgressEvent): void {
    try {
      const result = sink.emit(event);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          Logger.warn('ProgressSink emit failed', {
            sink: sink.name,
            eventKind: event.kind,
            err,
          });
        });
      }
    } catch (err) {
      Logger.warn('ProgressSink emit failed', {
        sink: sink.name,
        eventKind: event.kind,
        err,
      });
    }
  }
}
