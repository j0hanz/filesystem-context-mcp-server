import type {
  LoggingLevel,
  LoggingMessageNotificationParams,
  McpServer,
} from '@modelcontextprotocol/server';

import { AsyncLocalStorage } from 'node:async_hooks';
import { hash as hashFunc } from 'node:crypto';
import { channel, tracingChannel } from 'node:diagnostics_channel';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import { inspect } from 'node:util';

import { isRecord, parseTrueEnvFlag } from './util.js';

// Aliases for observability subsystem
const AsyncLocalStorageImport = AsyncLocalStorage;
const channelFunc = channel;

interface SessionContextData {
  sessionId?: string;
}

export const SessionContext = new AsyncLocalStorage<SessionContextData>();

interface LogEvent {
  level: LoggingLevel;
  message: string;
  data?: unknown;
  sessionId?: string;
}

const LOG_CHANNEL = channel('filesystem-mcp:log');
const MCP_LOGGER_NAME = 'filesystem-mcp';

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
  outcome?: 'success' | 'error' | 'cancelled' | 'rejected';
  duration_ms?: number;
  session_id?: string | null;
  traceparent?: string;
  [key: string]: unknown;
}

function toLogfmt(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}=[${v.join(',')}]`;
      }
      if (typeof v === 'string') {
        if (v.includes(' ') || v.includes('"') || v.includes('=')) {
          return `${k}=${JSON.stringify(v)}`;
        }
        return `${k}=${v}`;
      }
      if (typeof v === 'number') {
        return `${k}=${Number.isInteger(v) ? v : v.toFixed(2)}`;
      }
      return `${k}=${JSON.stringify(v)}`;
    })
    .join(' ');
}

export function emitWideEvent(level: WideEventLevel, payload: WideEventPayload): void {
  // We omit the heavy static wide event context here to make logs LLM-friendly,
  // but keep timestamp and dynamic payload so it's dense and valuable.
  const eventToLog = {
    timestamp: new Date().toISOString(),
    ...payload,
  };
  Logger.emit(level, toLogfmt(eventToLog));
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

function canSendMcpLogs(server: McpServer): boolean {
  const capabilities = server.server.getClientCapabilities();
  if (!capabilities || typeof capabilities !== 'object') return false;
  return 'logging' in capabilities && Boolean(capabilities.logging);
}

export function logToMcp(
  server: McpServer | undefined,
  level: LoggingLevel,
  data: string,
  minLevel: LoggingLevel = 'debug',
): void {
  if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[minLevel]) {
    return;
  }
  if (!server || !canSendMcpLogs(server)) {
    console.error(`[${level.toUpperCase()}] ${data}`);
    return;
  }

  const params: LoggingMessageNotificationParams = {
    level,
    logger: MCP_LOGGER_NAME,
    data,
  };

  void server.sendLoggingMessage(params).catch((error: unknown) => {
    console.error(`Failed to send MCP log: ${level} | ${data}`, formatTransportError(error));
  });
}

function formatTransportError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
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
  server: McpServer;
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
      logToMcp(
        target.server,
        event.level,
        `${event.message}${dataStr}`,
        target.loggingState.minimumLevel,
      );
      return;
    }
    console.error(`[${event.level.toUpperCase()}] ${event.message}${dataStr}`);
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
let traceCounter = 0;

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

  return safeStringify(source);
}

function extractOutcome(result: unknown): { ok: boolean; error?: string } {
  if (!isRecord(result)) return { ok: true };

  if (result['isError'] === true) {
    return { ok: false, error: extractErrorMessage(result) };
  }

  if (typeof result['ok'] === 'boolean') {
    return result['ok'] ? { ok: true } : { ok: false, error: extractErrorMessage(result) };
  }

  const struct = result['structuredContent'];
  if (isRecord(struct) && typeof struct['ok'] === 'boolean') {
    if (struct['ok']) return { ok: true };
    const err =
      typeof struct['error'] === 'string'
        ? struct['error']
        : isRecord(struct['error']) && typeof struct['error']['message'] === 'string'
          ? struct['error']['message']
          : undefined;
    return err ? { ok: false, error: err } : { ok: false };
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

function sanitizePathForDiagnostics(path: string | undefined): string | undefined {
  const { detail } = readConfig();
  if (!path || detail === 0) return undefined;
  if (detail === 2) return path;
  return hashFunc('sha256', path, 'hex').slice(0, 16);
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
    for (const entry of entries) {
      CHANNELS.perf.publish({
        phase: 'measure',
        name: entry.name,
        durationMs: entry.duration,
        detail: (entry as { detail?: unknown }).detail,
      } satisfies PerfDiagnosticsEvent);
    }
    try {
      // Keep the global timeline bounded while preserving published events.
      clearPublishedMeasures(entries);
    } catch {
      // Never allow observability cleanup to affect tool execution.
    }
  });
  perfObserver.observe({ entryTypes: ['measure'] });
}

// --- Public API ---

export function shouldPublishOpsTrace(): boolean {
  return readConfig().enabled && CHANNELS.ops.hasSubscribers;
}

export function publishOpsTraceStart(context: OpsTraceContext): void {
  CHANNELS.ops.start.publish(buildOpsTraceContext(context));
}

export function publishOpsTraceEnd(context: OpsTraceContext): void {
  CHANNELS.ops.end.publish(buildOpsTraceContext(context));
}

export function publishOpsTraceError(context: OpsTraceContext, error: unknown): void {
  CHANNELS.ops.error.publish({
    ...buildOpsTraceContext(context),
    error,
  });
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

export function getToolContextSnapshot(): { tool: string; path?: string } | undefined {
  return toolContext.getStore();
}

export function getTraceContext(): TraceContext | undefined {
  return toolContext.getStore()?.traceContext;
}

/**
 * Read W3C traceparent from _meta, checking both namespaced and legacy keys.
 * Namespaced key (io.opentelemetry/traceparent) is preferred for new messages.
 * Legacy key (traceparent) is checked for backward compatibility during transition.
 */
export function readTraceparent(meta?: Record<string, unknown>): string | undefined {
  if (!meta) return undefined;
  // Try new namespaced key first
  const namespaced = meta['io.opentelemetry/traceparent'];
  if (typeof namespaced === 'string') return namespaced;
  // Fall back to legacy key for compatibility
  const legacy = meta['traceparent'];
  return typeof legacy === 'string' ? legacy : undefined;
}

/**
 * Read W3C tracestate from _meta, checking both namespaced and legacy keys.
 */
export function readTracestate(meta?: Record<string, unknown>): string | undefined {
  if (!meta) return undefined;
  const namespaced = meta['io.opentelemetry/tracestate'];
  if (typeof namespaced === 'string') return namespaced;
  const legacy = meta['tracestate'];
  return typeof legacy === 'string' ? legacy : undefined;
}

/**
 * Read W3C baggage from _meta, checking both namespaced and legacy keys.
 */
export function readBaggage(meta?: Record<string, unknown>): string | undefined {
  if (!meta) return undefined;
  const namespaced = meta['io.opentelemetry/baggage'];
  if (typeof namespaced === 'string') return namespaced;
  const legacy = meta['baggage'];
  return typeof legacy === 'string' ? legacy : undefined;
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
  const startMark = `${name}:start:${id}`;
  const endMark = `${name}:end:${id}`;
  const runInCapturedContext = AsyncLocalStorageImport.snapshot();
  let finished = false;

  performance.mark(startMark);

  return (ok?: boolean) => {
    if (finished) return;
    finished = true;

    try {
      runInCapturedContext(() => {
        try {
          performance.mark(endMark);

          let meta = enrichWithToolContext(detail);
          if (ok !== undefined) {
            meta = { ...(meta ?? {}), ok };
          }

          performance.measure(name, {
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
  CHANNELS.tool.publish(event);
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
  CHANNELS.tool.publish(event);
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
  CHANNELS.perf.publish(event);
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
  loopMonitor?.disable();

  if (options.pubPerf && eluStart) {
    publishPerfEnd(tool, durationMs, eluStart, loopMonitor);
  }
  if (options.pubTool) {
    publishToolEnd(tool, obs.ok, durationMs, obs.errorMsg, options.traceparent);
  }

  if (options.logErrors && !obs.ok) {
    logError(tool, durationMs, obs.errorMsg);
  }
}

async function runAndObserve<T>(
  tool: string,
  run: () => Promise<T>,
  options: ObserveOptions,
): Promise<T> {
  const startMs = performance.now();
  const eluStart = options.pubPerf ? performance.eventLoopUtilization() : undefined;
  const loopMonitor = options.pubPerf ? monitorEventLoopDelay() : undefined;
  loopMonitor?.enable();

  if (options.pubTool) publishToolStart(tool, options.pathVal, options.traceparent);

  let result: T;
  let ok = false;
  let errorMsg: string | undefined;

  try {
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
    if (!ok) logError(tool, duration, error);
    return res;
  } catch (e) {
    const duration = performance.now() - start;
    logError(tool, duration, extractErrorMessage(e));
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
