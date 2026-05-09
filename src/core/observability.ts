import { AsyncLocalStorage } from 'node:async_hooks';
import { hash } from 'node:crypto';
import { channel, tracingChannel } from 'node:diagnostics_channel';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';

import { parseTrueEnvFlag } from './constants.js';
import { Logger } from './logger.js';
import { isRecord } from './utils.js';

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
    enabled: parseTrueEnvFlag(ENV.FS_CONTEXT_DIAGNOSTICS),
    detail: parseDetail(ENV.FS_CONTEXT_DIAGNOSTICS_DETAIL),
    logToolErrors: parseTrueEnvFlag(ENV.FS_CONTEXT_TOOL_LOG_ERRORS),
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
  tool: channel('filesystem-mcp:tool'),
  perf: channel('filesystem-mcp:perf'),
  ops: tracingChannel<unknown, OpsTraceContext>('filesystem-mcp:ops'),
};

const toolContext = new AsyncLocalStorage<ToolAsyncContext>({
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
  const struct = source.structuredContent;
  if (isRecord(struct)) {
    const structErr = struct.error;
    if (typeof structErr === 'string') return structErr;
    if (isRecord(structErr) && typeof structErr.message === 'string') {
      return structErr.message;
    }
  }

  // Check direct properties
  if (typeof source.error === 'string') return source.error;
  if (isRecord(source.error) && typeof source.error.message === 'string') {
    return source.error.message;
  }
  if (typeof source.message === 'string') return source.message;

  return safeStringify(source);
}

function extractOutcome(result: unknown): { ok: boolean; error?: string } {
  if (!isRecord(result)) return { ok: true };

  if (result.isError === true) {
    return { ok: false, error: extractErrorMessage(result) };
  }

  if (typeof result.ok === 'boolean') {
    return result.ok ? { ok: true } : { ok: false, error: extractErrorMessage(result) };
  }

  const struct = result.structuredContent;
  if (isRecord(struct) && typeof struct.ok === 'boolean') {
    if (struct.ok) return { ok: true };
    const err =
      typeof struct.error === 'string'
        ? struct.error
        : isRecord(struct.error) && typeof struct.error.message === 'string'
          ? struct.error.message
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
  return hash('sha256', path, 'hex').slice(0, 16);
}

function enrichWithToolContext(
  detail?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const current = toolContext.getStore();
  if (!current) return detail;

  const merged: Record<string, unknown> = { ...(detail ?? {}) };
  if (merged.tool === undefined) {
    merged.tool = current.tool;
  }

  if (merged.path === undefined && current.normalizedPath) {
    merged.path = current.normalizedPath;
  } else if (merged.path !== undefined) {
    const hashed = sanitizePathForDiagnostics(merged.path as string);
    if (hashed) {
      merged.path = hashed;
    } else {
      delete merged.path;
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
  const runInCapturedContext = AsyncLocalStorage.snapshot();
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
