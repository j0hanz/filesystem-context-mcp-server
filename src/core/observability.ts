import { AsyncLocalStorage } from 'node:async_hooks';
import { hash as hashFunc } from 'node:crypto';
import { channel, tracingChannel } from 'node:diagnostics_channel';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import { inspect } from 'node:util';

import { ansiLine, type Phase, type ProgressCtx } from './fmt.js';
import { isRecord, parseTrueEnvFlag } from './primitives.js';

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

// Aliases for observability subsystem
const AsyncLocalStorageImport = AsyncLocalStorage;
const channelFunc = channel;

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

type WideEventLevel = LoggingLevel;

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
  level: WideEventLevel,
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
    const fallbackMinLevel = (ENV['FS_CONTEXT_MIN_LOG_LEVEL'] ?? 'notice') as LoggingLevel;
    if (LOG_LEVEL_ORDER[event.level] >= LOG_LEVEL_ORDER[fallbackMinLevel]) {
      console.error(`[${event.level.toUpperCase()}] ${event.message}${dataStr}`);
    }
  }
}

// --- Configuration ---

const ENV = process.env;

interface Config {
  enabled: boolean;
  detail: 0 | 1 | 2;
  logToolErrors: boolean;
}

let _cachedConfig: Config | undefined;

function readConfig(): Config {
  _cachedConfig ??= {
    enabled: parseTrueEnvFlag(ENV['FS_CONTEXT_DIAGNOSTICS']),
    detail: parseDetail(ENV['FS_CONTEXT_DIAGNOSTICS_DETAIL']),
    logToolErrors: parseTrueEnvFlag(ENV['FS_CONTEXT_TOOL_LOG_ERRORS']),
  };
  return _cachedConfig;
}

function parseDetail(val?: string): 0 | 1 | 2 {
  if (val === '2') return 2;
  if (val === '1') return 1;
  return 0;
}

// --- Domain Types ---

interface OpsTraceContext {
  op: string;
  engine?: string;
  tool?: string;
  path?: string | undefined;
  [key: string]: unknown;
}

export interface TraceContext {
  traceparent: string;
  tracestate?: string;
  baggage?: string;
}

interface ToolDiagnosticsEvent {
  phase: 'start' | 'end';
  tool: string;
  durationMs?: number;
  ok?: boolean;
  error?: string;
  path?: string;
  traceparent?: string;
}

interface ToolAsyncContext {
  tool: string;
  path?: string;
  normalizedPath?: string;
  traceContext?: TraceContext;
}

interface PerfDiagnosticsEvent {
  phase: 'end' | 'measure';
  tool?: string;
  name?: string;
  durationMs: number;
  elu?: { idle: number; active: number; utilization: number };
  eventLoopDelay?: {
    min: number;
    max: number;
    mean: number;
    p50: number;
    p95: number;
    p99: number;
    exceeds: number;
  };
  detail?: unknown;
}

// --- Channels & Observability State ---

const CHANNELS = {
  tool: channelFunc('filesystem-mcp:tool'),
  perf: channelFunc('filesystem-mcp:perf'),
  ops: tracingChannel<unknown, OpsTraceContext>('filesystem-mcp:ops'),
};

const toolContext = new AsyncLocalStorageImport<ToolAsyncContext>({
  name: 'filesystem-mcp:tool',
});

let perfObserver: PerformanceObserver | undefined;
let globalLoopMonitor: ReturnType<typeof monitorEventLoopDelay> | undefined;
let traceCounter = 0;

function getGlobalLoopMonitor(): ReturnType<typeof monitorEventLoopDelay> {
  if (!globalLoopMonitor) {
    globalLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
    try {
      globalLoopMonitor.enable();
    } catch (err) {
      console.error('Failed to enable event loop delay monitor:', err);
    }
  }
  return globalLoopMonitor;
}

// --- Helpers: Result Analysis ---

function extractErrorMessage(source: unknown): string {
  if (typeof source === 'string') return source;
  if (source instanceof Error) return source.message;
  if (!isRecord(source)) return safeStringify(source);

  // Check structured content first
  const struct = source['structuredContent'];
  if (isRecord(struct)) {
    const structErr = struct['error'];
    if (typeof structErr === 'string') return structErr;
    if (isRecord(structErr) && typeof structErr['message'] === 'string') {
      return structErr['message'];
    }
  }

  // Check direct properties
  if (typeof source['error'] === 'string') return source['error'];
  if (isRecord(source['error']) && typeof source['error']['message'] === 'string') {
    return source['error']['message'];
  }
  if (typeof source['message'] === 'string') return source['message'];

  // MCP error response shape: { isError: true, content: [{ type: 'text', text: '...' }] }
  const content: unknown = source['content'];
  if (Array.isArray(content) && content.length > 0) {
    const first: unknown = content[0];
    if (isRecord(first) && typeof first['text'] === 'string') return first['text'];
  }

  return safeStringify(source);
}

export function extractOutcome(result: unknown): { ok: boolean; error?: string } {
  if (result instanceof Error) {
    return { ok: false, error: result.message };
  }
  if (!isRecord(result)) return { ok: true };

  if (result['isError'] === true) {
    return { ok: false, error: extractErrorMessage(result) };
  }

  if (typeof result['ok'] === 'boolean') {
    return result['ok'] ? { ok: true } : { ok: false, error: extractErrorMessage(result) };
  }

  if (result['error'] !== undefined) {
    return { ok: false, error: extractErrorMessage(result) };
  }

  const struct = result['structuredContent'];
  if (isRecord(struct)) {
    if (typeof struct['ok'] === 'boolean') {
      if (struct['ok']) return { ok: true };
      const err =
        typeof struct['error'] === 'string'
          ? struct['error']
          : isRecord(struct['error']) && typeof struct['error']['message'] === 'string'
            ? struct['error']['message']
            : undefined;
      return err ? { ok: false, error: err } : { ok: false };
    }
    if (struct['error'] !== undefined) {
      return { ok: false, error: extractErrorMessage(struct) };
    }
  }

  return { ok: true };
}

function safeStringify(source: unknown): string {
  try {
    return String(source);
  } catch {
    return 'Unknown error';
  }
}

export function sanitizePathForDiagnostics(path: string | undefined): string | undefined {
  const { detail } = readConfig();
  if (typeof path !== 'string' || !path || detail === 0) return undefined;
  if (detail === 2) return path;
  try {
    return hashFunc('sha256', path, 'hex').slice(0, 16);
  } catch {
    return undefined;
  }
}

function enrichWithToolContext(
  detail?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const current = toolContext.getStore();
  if (!current) return detail;

  const merged: Record<string, unknown> = { ...(detail ?? {}) };
  if (merged['tool'] === undefined) {
    merged['tool'] = current.tool;
  }

  if (merged['path'] === undefined && current.normalizedPath) {
    merged['path'] = current.normalizedPath;
  } else if (merged['path'] !== undefined) {
    const hashed = sanitizePathForDiagnostics(merged['path'] as string);
    if (hashed) {
      merged['path'] = hashed;
    } else {
      delete merged['path'];
    }
  }

  return merged;
}

// --- Perf Helpers ---

function getDelayStats(
  h: ReturnType<typeof monitorEventLoopDelay>,
): NonNullable<PerfDiagnosticsEvent['eventLoopDelay']> | undefined {
  if (h.count === 0) return undefined;
  return {
    min: h.min / 1_000_000,
    max: h.max / 1_000_000,
    mean: h.mean / 1_000_000,
    p50: h.percentile(50) / 1_000_000,
    p95: h.percentile(95) / 1_000_000,
    p99: h.percentile(99) / 1_000_000,
    exceeds: h.exceeds,
  };
}

function clearPublishedMeasures(entries: readonly { name: string }[]): void {
  for (const entry of entries) {
    performance.clearMeasures(entry.name);
  }
}

function ensureObserver(): void {
  if (perfObserver) return;
  perfObserver = new PerformanceObserver((list) => {
    const entries = list.getEntries();
    const ours: { name: string }[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('filesystem-mcp:')) {
        ours.push(entry);
        const originalName = entry.name.slice('filesystem-mcp:'.length);
        try {
          CHANNELS.perf.publish({
            phase: 'measure',
            name: originalName,
            durationMs: entry.duration,
            detail: (entry as { detail?: unknown }).detail,
          } satisfies PerfDiagnosticsEvent);
        } catch (err) {
          console.error('[ensureObserver] Failed to publish perf measure event', err);
        }
      }
    }
    try {
      // Keep the global timeline bounded while preserving published events.
      clearPublishedMeasures(ours);
    } catch {
      // Never allow observability cleanup to affect tool execution.
    }
  });
  perfObserver.observe({ entryTypes: ['measure'] });
}

// --- Public API ---

function shouldPublishOpsTrace(): boolean {
  return readConfig().enabled && CHANNELS.ops.hasSubscribers;
}

function publishOpsTraceStart(context: OpsTraceContext): void {
  try {
    CHANNELS.ops.start.publish(buildOpsTraceContext(context));
  } catch (err) {
    console.error('[publishOpsTraceStart] Failed', err);
  }
}

function publishOpsTraceEnd(context: OpsTraceContext): void {
  try {
    CHANNELS.ops.end.publish(buildOpsTraceContext(context));
  } catch (err) {
    console.error('[publishOpsTraceEnd] Failed', err);
  }
}

function publishOpsTraceError(context: OpsTraceContext, error: unknown): void {
  try {
    CHANNELS.ops.error.publish({
      ...buildOpsTraceContext(context),
      error,
    });
  } catch (err) {
    console.error('[publishOpsTraceError] Failed', err);
  }
}

/**
 * Wraps an async generator with ops-trace start/end/error events. Tool context
 * is auto-merged from the current `withToolDiagnostics` ALS. No-op when ops
 * diagnostics are disabled or the channel has no subscribers.
 */
export async function* withOpsTrace<T>(
  context: OpsTraceContext,
  gen: () => AsyncGenerator<T>,
): AsyncGenerator<T> {
  if (!shouldPublishOpsTrace()) {
    yield* gen();
    return;
  }
  publishOpsTraceStart(context);
  try {
    yield* gen();
  } catch (error) {
    publishOpsTraceError(context, error);
    throw error;
  } finally {
    publishOpsTraceEnd(context);
  }
}

function buildOpsTraceContext(context: OpsTraceContext): OpsTraceContext {
  const current = toolContext.getStore();
  const merged: OpsTraceContext = { ...context };

  if (current && merged.tool === undefined) {
    merged.tool = current.tool;
  }

  const path = merged.path ?? current?.path;
  if (path) {
    const hashed = sanitizePathForDiagnostics(path);
    if (hashed) {
      merged.path = hashed;
    } else {
      delete merged.path;
    }
  } else {
    delete merged.path;
  }

  return merged;
}

export function getTraceContext(): TraceContext | undefined {
  return toolContext.getStore()?.traceContext;
}

function clearMeasureMarks(startMark: string, endMark: string): void {
  performance.clearMarks(startMark);
  performance.clearMarks(endMark);
}

export function startPerfMeasure(
  name: string,
  detail?: Record<string, unknown>,
): ((ok?: boolean) => void) | undefined {
  if (!readConfig().enabled || !CHANNELS.perf.hasSubscribers) return undefined;

  ensureObserver();
  const id = ++traceCounter;
  const prefixedName = `filesystem-mcp:${name}`;
  const startMark = `${prefixedName}:start:${id}`;
  const endMark = `${prefixedName}:end:${id}`;
  const runInCapturedContext = AsyncLocalStorageImport.snapshot();
  let finished = false;

  performance.mark(startMark);

  // Safety timeout: auto-clear marks after 5 minutes if never finished to prevent timeline leak
  const safetyTimeout = setTimeout(() => {
    if (!finished) {
      finished = true;
      clearMeasureMarks(startMark, endMark);
    }
  }, 300000);
  try {
    safetyTimeout.unref();
  } catch {
    // Ignore unref failures in non-Node environments
  }

  return (ok?: boolean) => {
    if (finished) return;
    finished = true;
    clearTimeout(safetyTimeout);

    try {
      runInCapturedContext(() => {
        try {
          performance.mark(endMark);

          let meta = enrichWithToolContext(detail);
          if (ok !== undefined) {
            meta = { ...(meta ?? {}), ok };
          }

          performance.measure(prefixedName, {
            start: startMark,
            end: endMark,
            detail: meta,
          });
        } finally {
          clearMeasureMarks(startMark, endMark);
        }
      });
    } catch {
      clearMeasureMarks(startMark, endMark);
    }
  };
}

function publishToolStart(tool: string, pathVal?: string, traceparent?: string): void {
  const event: ToolDiagnosticsEvent = { phase: 'start', tool };
  if (pathVal) event.path = pathVal;
  if (traceparent) event.traceparent = traceparent;
  try {
    CHANNELS.tool.publish(event);
  } catch (err) {
    console.error('[publishToolStart] Failed', err);
  }
}

function publishToolEnd(
  tool: string,
  ok: boolean,
  durationMs: number,
  errorMsg?: string,
  traceparent?: string,
): void {
  const event: ToolDiagnosticsEvent = { phase: 'end', tool, ok, durationMs };
  if (errorMsg) event.error = errorMsg;
  if (traceparent) event.traceparent = traceparent;
  try {
    CHANNELS.tool.publish(event);
  } catch (err) {
    console.error('[publishToolEnd] Failed', err);
  }
}

function publishPerfEnd(
  tool: string,
  durationMs: number,
  eluStart: ReturnType<typeof performance.eventLoopUtilization>,
  loopMonitor?: ReturnType<typeof monitorEventLoopDelay>,
): void {
  const elu = performance.eventLoopUtilization(eluStart);
  const event: PerfDiagnosticsEvent = {
    phase: 'end',
    tool,
    durationMs,
    elu: { idle: elu.idle, active: elu.active, utilization: elu.utilization },
  };
  if (loopMonitor) {
    const delays = getDelayStats(loopMonitor);
    if (delays) event.eventLoopDelay = delays;
  }
  try {
    CHANNELS.perf.publish(event);
  } catch (err) {
    console.error('[publishPerfEnd] Failed', err);
  }
}

interface ObserveOptions {
  pubTool: boolean;
  pubPerf: boolean;
  logErrors: boolean;
  pathVal?: string;
  traceparent?: string;
}

function finalizeObservation(
  tool: string,
  options: ObserveOptions,
  durationMs: number,
  obs: { ok: boolean; errorMsg: string | undefined },
  eluStart?: ReturnType<typeof performance.eventLoopUtilization>,
  loopMonitor?: ReturnType<typeof monitorEventLoopDelay>,
): void {
  try {
    if (options.pubPerf && eluStart) {
      publishPerfEnd(tool, durationMs, eluStart, loopMonitor);
    }
    if (options.pubTool) {
      publishToolEnd(tool, obs.ok, durationMs, obs.errorMsg, options.traceparent);
    }
    if (options.logErrors && !obs.ok) {
      logError(tool, durationMs, obs.errorMsg);
    }
  } catch (err) {
    console.error('Failed to finalize observation', err);
  }
}

async function runAndObserve<T>(
  tool: string,
  run: () => Promise<T>,
  options: ObserveOptions,
): Promise<T> {
  const startMs = performance.now();
  const eluStart = options.pubPerf ? performance.eventLoopUtilization() : undefined;
  const loopMonitor = options.pubPerf ? getGlobalLoopMonitor() : undefined;

  let result: T;
  let ok = false;
  let errorMsg: string | undefined;

  try {
    if (options.pubTool) {
      publishToolStart(tool, options.pathVal, options.traceparent);
    }
    result = await run();
    const outcome = extractOutcome(result);
    ok = outcome.ok;
    errorMsg = outcome.error;
  } catch (err) {
    errorMsg = extractErrorMessage(err);
    throw err;
  } finally {
    const durationMs = performance.now() - startMs;
    finalizeObservation(tool, options, durationMs, { ok, errorMsg }, eluStart, loopMonitor);
  }

  return result;
}

async function runWithBasicErrorLogging<T>(tool: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const res = await run();
    const duration = performance.now() - start;
    const { ok, error } = extractOutcome(res);
    if (!ok) {
      try {
        logError(tool, duration, error);
      } catch (logErr) {
        console.error('[runWithBasicErrorLogging] Failed to log tool error', logErr);
      }
    }
    return res;
  } catch (e) {
    const duration = performance.now() - start;
    try {
      logError(tool, duration, extractErrorMessage(e));
    } catch (logErr) {
      console.error('[runWithBasicErrorLogging] Failed to log tool error', logErr);
    }
    throw e;
  }
}

function buildObserveOptions(
  pubTool: boolean,
  pubPerf: boolean,
  logErrors: boolean,
  normalizedPath?: string,
  traceparent?: string,
): ObserveOptions {
  return {
    pubTool,
    pubPerf,
    logErrors,
    ...(normalizedPath ? { pathVal: normalizedPath } : {}),
    ...(traceparent ? { traceparent } : {}),
  };
}

async function executeInContext<T>(
  tool: string,
  run: () => Promise<T>,
  config: Config,
  normalizedPath?: string,
  traceparent?: string,
): Promise<T> {
  if (!config.enabled) {
    return config.logToolErrors ? runWithBasicErrorLogging(tool, run) : run();
  }

  const pubTool = CHANNELS.tool.hasSubscribers;
  const pubPerf = CHANNELS.perf.hasSubscribers;

  if (!pubTool && !pubPerf) return run();

  const options = buildObserveOptions(
    pubTool,
    pubPerf,
    config.logToolErrors,
    normalizedPath,
    traceparent,
  );

  return runAndObserve(tool, run, options);
}

export async function withToolDiagnostics<T>(
  tool: string,
  run: () => Promise<T>,
  options?: { path?: string; traceContext?: TraceContext },
): Promise<T> {
  const config = readConfig();
  const normalizedPath = sanitizePathForDiagnostics(options?.path);

  const context: ToolAsyncContext = {
    tool,
    ...(options?.path ? { path: options.path } : {}),
    ...(normalizedPath ? { normalizedPath } : {}),
    ...(options?.traceContext ? { traceContext: options.traceContext } : {}),
  };

  return toolContext.run(context, () =>
    executeInContext(tool, run, config, normalizedPath, options?.traceContext?.traceparent),
  );
}

function logError(tool: string, durationMs: number, msg?: string): void {
  const suffix = msg ? `: ${msg}` : '';
  Logger.error(`[ToolError] ${tool} failed in ${durationMs.toFixed(1)}ms${suffix}`);
}

// --- Progress Session ---

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

export class StderrProgressSink implements ProgressSink {
  readonly name = 'stderr';
  readonly #startMs: number;
  #ctx: ProgressCtx;
  readonly #writeFn: (line: string) => void;

  constructor(ctx: ProgressCtx, writeFn?: (line: string) => void) {
    this.#ctx = ctx;
    this.#startMs = Date.now();
    this.#writeFn =
      writeFn ??
      ((line) => {
        process.stderr.write(line + '\n');
      });
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
          : event.kind === 'tick' && event.current === 0
            ? 'start'
            : 'tick';

    const merged: ProgressCtx = {
      ...this.#ctx,
      ...(event.message ? { subject: event.message } : {}),
      ...(event.kind === 'tick' || event.kind === 'complete'
        ? { current: event.current, total: event.total }
        : {}),
      ...(event.kind === 'fail'
        ? { error: event.error instanceof Error ? event.error.message : String(event.error) }
        : {}),
      durationMs: Date.now() - this.#startMs,
    };

    try {
      this.#writeFn(ansiLine(phase, merged));
    } catch {
      // never allow observability failures to affect tool execution
    }
  }
}
