import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';
import { inspect } from 'node:util';

// ════════════════════════════════════════════════════════════
// Logging — Logger singleton, LogRouter, structured log emit
// ════════════════════════════════════════════════════════════

export type LoggingLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

export interface LogSender {
  send(level: LoggingLevel, message: string): Promise<void>;
}

interface SessionContextData {
  sessionId?: string;
}

const SessionContext = new AsyncLocalStorage<SessionContextData>();

export function withSession<T>(sessionId: string | undefined, run: () => Promise<T>): Promise<T> {
  const store: SessionContextData = sessionId ? { sessionId } : {};
  return SessionContext.run(store, run);
}

interface LogEvent {
  level: LoggingLevel;
  message: string;
  data?: unknown;
  sessionId?: string;
}

const LOG_CHANNEL = channel('filesystem-mcp:log');

const LOG_LEVEL_ORDER: Record<LoggingLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7,
};

export interface LoggingState {
  minimumLevel: LoggingLevel;
}

export function createLoggingState(minimumLevel: LoggingLevel = 'debug'): LoggingState {
  return { minimumLevel };
}

interface WideEventPayload {
  event: string;
  action?: string;
  display_name?: string;
  duration_ms?: number;
  error_message?: string;
  error_type?: string;
  execution_id?: string;
  http_status?: number;
  input_keys?: readonly string[];
  input_size_bytes?: number;
  jsonrpc_method?: string;
  memory_delta_mb?: number;
  method?: string;
  operation?: string;
  outcome?: 'success' | 'error' | 'cancelled' | 'rejected';
  path?: string;
  prompt_name?: string;
  tool_progress_ticks?: number;
  progress_notifications_emitted?: number;
  task_status_updates_requested?: number;
  reason?: string;
  request_kind?: 'request' | 'notification' | 'result' | 'error' | 'unknown';
  result_size_bytes?: number;
  scope?: string;
  session_id?: string | null;
  tool_name?: string;
  transport?: string;
  traceparent?: string;
  uri?: string;
}

export function toLogfmt(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      const escapedKey = /[\s"=\\]/.test(k) ? JSON.stringify(k) : k;

      if (Array.isArray(v)) {
        const mapped = v.map((item) => {
          if (typeof item === 'string' && /[\s"=\\]/.test(item)) {
            try {
              return JSON.stringify(item);
            } catch {
              return item;
            }
          }
          return String(item);
        });
        return `${escapedKey}=[${mapped.join(',')}]`;
      }
      if (v instanceof Error) {
        return `${escapedKey}=${JSON.stringify(v.stack ?? v.message)}`;
      }
      if (typeof v === 'bigint') {
        return `${escapedKey}=${v.toString()}`;
      }
      if (typeof v === 'string') {
        if (/[\s"=\\]/.test(v)) {
          try {
            return `${escapedKey}=${JSON.stringify(v)}`;
          } catch {
            return `${escapedKey}=[Unserializable]`;
          }
        }
        return `${escapedKey}=${v}`;
      }
      if (typeof v === 'number') {
        return `${escapedKey}=${Number.isInteger(v) ? v : v.toFixed(2)}`;
      }
      try {
        return `${escapedKey}=${JSON.stringify(v)}`;
      } catch {
        return `${escapedKey}=[Unserializable]`;
      }
    })
    .join(' ');
}

export function emitWideEvent(
  level: LoggingLevel,
  payload: WideEventPayload & Record<string, unknown>,
): void {
  // We omit the heavy static wide event context here to make logs LLM-friendly,
  // but keep timestamp and dynamic payload so it's dense and valuable.
  const eventToLog = {
    timestamp: new Date().toISOString(),
    ...payload,
  };
  Logger.emit(level, toLogfmt(eventToLog));
}

export async function withTelemetry<T>(
  baseEvent: { event: string; [key: string]: unknown },
  handler: (enrich: (extraData: Record<string, unknown>) => void) => Promise<T> | T,
): Promise<T> {
  const start = performance.now();
  let extraData: Record<string, unknown> = {};
  const enrich = (data: Record<string, unknown>) => {
    extraData = { ...extraData, ...data };
  };

  try {
    const result = await handler(enrich);
    const outcome =
      (extraData['outcome'] as 'success' | 'error' | 'cancelled' | 'rejected' | undefined) ??
      'success';
    const level = outcome === 'error' || outcome === 'rejected' ? 'error' : 'info';
    try {
      emitWideEvent(level, {
        ...baseEvent,
        outcome,
        duration_ms: performance.now() - start,
        ...extraData,
      });
    } catch (telemetryError) {
      console.error('[withTelemetry] emitWideEvent failed on success path', telemetryError);
    }
    return result;
  } catch (error) {
    const rawOutcome = extraData['outcome'];
    const outcome =
      rawOutcome === 'cancelled' || rawOutcome === 'rejected' || rawOutcome === 'error'
        ? rawOutcome
        : 'error';
    try {
      emitWideEvent('error', {
        ...baseEvent,
        outcome,
        error_message: error instanceof Error ? error.message : String(error),
        duration_ms: performance.now() - start,
        ...extraData,
      });
    } catch (telemetryError) {
      console.error('[withTelemetry] emitWideEvent failed on error path', telemetryError);
    }
    throw error;
  }
}

export function logRuntimeFailure(
  reason: string,
  scope: string,
  operation: string,
  error: unknown,
): void {
  emitWideEvent('error', {
    event: 'runtime_failure',
    reason,
    scope,
    operation,
    outcome: 'error',
    error_message: formatTransportError(error),
  });
}

export function logToSender(
  sender: LogSender | undefined,
  level: LoggingLevel,
  data: string,
  minLevel: LoggingLevel = 'debug',
): void {
  if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[minLevel]) {
    return;
  }
  if (!sender) {
    console.error(`[${level.toUpperCase()}] ${data}`);
    return;
  }

  try {
    void sender.send(level, data).catch((error: unknown) => {
      console.error(`Failed to send log: ${level} | ${data}`, formatTransportError(error));
    });
  } catch (error) {
    console.error(
      `Failed to send log synchronously: ${level} | ${data}`,
      formatTransportError(error),
    );
  }
}

export function formatTransportError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    try {
      return inspect(error, { depth: 2, colors: false });
    } catch {
      return String(error);
    }
  }
}

export const Logger = {
  emit(level: LoggingLevel, message: string, data?: unknown): void {
    const session = SessionContext.getStore();
    const event: LogEvent = {
      level,
      message,
      ...(data !== undefined ? { data } : {}),
      ...(session?.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
    };

    if (LOG_CHANNEL.hasSubscribers) {
      LOG_CHANNEL.publish(event);
    } else {
      // Fallback if no subscribers
      console.error(`[${level.toUpperCase()}] ${message}`, data ?? '');
    }
  },

  debug(message: string, data?: unknown): void {
    this.emit('debug', message, data);
  },

  info(message: string, data?: unknown): void {
    this.emit('info', message, data);
  },

  notice(message: string, data?: unknown): void {
    this.emit('notice', message, data);
  },

  warn(message: string, data?: unknown): void {
    this.emit('warning', message, data);
  },

  error(message: string, data?: unknown): void {
    this.emit('error', message, data);
  },

  critical(message: string, data?: unknown): void {
    this.emit('critical', message, data);
  },
};

/**
 * Routes log events from the `filesystem-mcp:log` diagnostics channel to the
 * correct McpServer. Stdio uses a single fallback target; HTTP attaches one
 * target per session keyed by `sessionId`. Subscribes to the channel exactly
 * once on first construction.
 */
export interface LogTarget {
  sender: LogSender;
  loggingState: LoggingState;
}

function stringifyLogData(data: unknown): string {
  if (data === undefined) return '';
  if (typeof data === 'string') return ` ${data}`;
  if (
    data === null ||
    typeof data === 'number' ||
    typeof data === 'boolean' ||
    typeof data === 'bigint'
  ) {
    return ` ${String(data)}`;
  }
  return ` ${inspect(data, { depth: 4, colors: false, compact: 3 })}`;
}

export class LogRouter {
  private static instance: LogRouter | undefined;
  private stdio: LogTarget | undefined;
  private readonly sessions = new Map<string, LogTarget>();

  private constructor() {
    LOG_CHANNEL.subscribe((message) => {
      this.dispatch(message as LogEvent);
    });
  }

  static global(): LogRouter {
    LogRouter.instance ??= new LogRouter();
    return LogRouter.instance;
  }

  attachStdio(target: LogTarget): void {
    this.stdio ??= target;
  }

  detachStdio(): void {
    this.stdio = undefined;
  }

  attachSession(sessionId: string, target: LogTarget): void {
    this.sessions.set(sessionId, target);
  }

  detachSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** For tests: forget all routing state without unsubscribing the channel. */
  reset(): void {
    this.stdio = undefined;
    this.sessions.clear();
  }

  private dispatch(event: LogEvent): void {
    const target = event.sessionId ? this.sessions.get(event.sessionId) : this.stdio;
    const dataStr = stringifyLogData(event.data);
    if (target) {
      logToSender(
        target.sender,
        event.level,
        `${event.message}${dataStr}`,
        target.loggingState.minimumLevel,
      );
      return;
    }
    const fallbackMinLevel = (process.env['FS_CONTEXT_MIN_LOG_LEVEL'] ?? 'notice') as LoggingLevel;
    if (LOG_LEVEL_ORDER[event.level] >= LOG_LEVEL_ORDER[fallbackMinLevel]) {
      console.error(`[${event.level.toUpperCase()}] ${event.message}${dataStr}`);
    }
  }
}

// ════════════════════════════════════════════════════════════
// Telemetry — withTelemetry, wide events
// ════════════════════════════════════════════════════════════
