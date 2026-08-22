import type { Notification, ProgressNotificationParams } from '@modelcontextprotocol/server';

import { formatUnknownErrorMessage } from '../core/errors.js';
import { ansiLine, type Phase, type ProgressCtx } from '../core/fmt.js';
import { Logger } from '../core/observability.js';

function reportDetachedError(toolName: string, context: string, error: unknown): void {
  const message = formatUnknownErrorMessage(error);
  Logger.emit('warning', `${toolName}: ${context} failed: ${message}`);
}

export type ProgressEvent =
  | { kind: 'tick'; current: number; total?: number; message: string }
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
  readonly emit: (event: ProgressEvent) => Promise<void> | void;
}

interface ProgressSessionOptions {
  label: string;
  total?: number;
  sinks: ProgressSink[];
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
    this.#rateLimitMs = opts.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
    this.#dynamicRateLimit = opts.dynamicRateLimit ?? false;

    const now = Date.now();
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

  set(input: { current: number; total?: number; message?: string }): void {
    if (this.#done) return;
    // The spec requires `progress` to increase on every notification, and the
    // constructor already dispatched current: 0. A repeated or backward tick
    // would put a duplicate value on the wire — drop it.
    if (input.current <= this.#cursor) return;
    this.#cursor = input.current;
    const total = input.total ?? this.#total;
    this.#dispatch({
      kind: 'tick',
      current: this.#cursor,
      ...(total !== undefined ? { total } : {}),
      message: input.message ?? this.#label,
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

    this.#lastSentMs = Date.now();

    for (const sink of this.#sinks) {
      this.#emitGuarded(sink, event);
    }
  }

  #shouldRateLimit(event: ProgressEvent): boolean {
    if (event.kind !== 'tick') {
      return false;
    }

    const now = Date.now();
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

export class StderrProgressSink implements ProgressSink {
  readonly name = 'stderr';
  readonly #startMs: number;
  #ctx: ProgressCtx;

  constructor(ctx: ProgressCtx) {
    this.#ctx = ctx;
    this.#startMs = Date.now();
  }

  updateCtx(extra: Partial<ProgressCtx>): void {
    this.#ctx = { ...this.#ctx, ...extra };
  }

  emit(event: ProgressEvent): void {
    if (!process.stderr.isTTY) return;

    const phase: Phase =
      event.kind === 'complete'
        ? 'done'
        : event.kind === 'fail'
          ? 'fail'
          : event.current === 0
            ? 'start'
            : 'tick';

    const merged: ProgressCtx = {
      ...this.#ctx,
      ...(event.kind === 'tick' || event.kind === 'complete'
        ? { current: event.current, total: event.total }
        : {}),
      ...(event.kind === 'fail' ? { error: formatUnknownErrorMessage(event.error) } : {}),
      durationMs: Date.now() - this.#startMs,
    };

    try {
      process.stderr.write(`${ansiLine(phase, merged)}
`);
    } catch {
      // never allow observability failures to affect tool execution
    }
  }
}

export class McpProgressSink implements ProgressSink {
  readonly name = 'mcp';
  private readonly toolName: string;
  private readonly token: string | number;
  private readonly notify: (n: Notification) => Promise<void>;
  readonly #pending = new Set<Promise<void>>();

  constructor(
    toolName: string,
    token: string | number,
    notify: (n: Notification) => Promise<void>,
  ) {
    this.toolName = toolName;
    this.token = token;
    this.notify = notify;
  }

  emit(event: ProgressEvent): void {
    let current = event.current;
    let total = event.total;
    if (event.kind === 'complete') {
      current = total ?? current;
      total = current;
    }
    const notificationParams: ProgressNotificationParams = {
      progressToken: this.token,
      progress: current,
      ...(total !== undefined ? { total } : {}),
      message: event.message,
    };
    const promise = this.notify({
      method: 'notifications/progress',
      params: notificationParams,
    })
      .catch((error: unknown) => {
        reportDetachedError(this.toolName, 'progressNotification', error);
      })
      .finally(() => {
        this.#pending.delete(promise);
      });
    this.#pending.add(promise);
  }

  async flush(): Promise<void> {
    if (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
  }
}
