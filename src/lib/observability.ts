import { AsyncLocalStorage } from 'node:async_hooks';
import { hash } from 'node:crypto';
import { channel, tracingChannel } from 'node:diagnostics_channel';
import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
} from 'node:perf_hooks';

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

// --- Metrics State ---

interface ToolMetrics {
  calls: number;
  errors: number;
  totalDurationMs: number;
}

export const globalMetrics = new Map<string, ToolMetrics>();

function updateMetrics(tool: string, ok: boolean, durationMs: number): void {
  const current = globalMetrics.get(tool) ?? {
    calls: 0,
    errors: 0,
    totalDurationMs: 0,
  };
  current.calls++;
  if (!ok) current.errors++;
  current.totalDurationMs += durationMs;
  globalMetrics.set(tool, current);
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

function extractOutcome(result: unknown): { ok: boolean; error?: string } {
  if (!isRecord(result)) {
    return { ok: true };
  }

  if (result.isError === true) {
    const err = extractErrorMessage(result);
    return { ok: false, error: err };
  }

  if (typeof result.ok === 'boolean') {
    if (result.ok) return { ok: true };
    return { ok: false, error: extractErrorMessage(result) };
  }

  const content = result.structuredContent;
  if (isRecord(content) && typeof content.ok === 'boolean') {
    if (content.ok) return { ok: true };
    const err = extractResultError(content);
    return err ? { ok: false, error: err } : { ok: false };
  }

  return { ok: true };
}

function extractErrorMessage(source: unknown): string {
  if (typeof source === 'string') return source;
  if (source instanceof Error) return source.message;
  if (isRecord(source)) {
    const struct = source.structuredContent;
    if (isRecord(struct)) {
      const err = struct.error;
      if (isRecord(err) && typeof err.message === 'string') return err.message;
    }
    if (typeof source.message === 'string') return source.message;
    const errObj = source.error;
    if (isRecord(errObj) && typeof errObj.message === 'string') {
      return errObj.message;
    }
  }
  try {
    return String(source);
  } catch {
    return 'Unknown error';
  }
}

function extractResultError(
  structured: Record<string, unknown>
): string | undefined {
  const err = structured.error;
  return isRecord(err) && typeof err.message === 'string'
    ? err.message
    : undefined;
}

function sanitizePathForDiagnostics(
  path: string | undefined
): string | undefined {
  const { detail } = readConfig();
  if (!path || detail === 0) return undefined;
  if (detail === 2) return path;
  return hash('sha256', path, 'hex').slice(0, 16);
}

function enrichWithToolContext(
  detail?: Record<string, unknown>
): Record<string, unknown> | undefined {
  const current = toolContext.getStore();
  if (!current) return detail;

  const merged: Record<string, unknown> = { ...(detail ?? {}) };
  if (!Object.hasOwn(merged, 'tool')) {
    merged.tool = current.tool;
  }

  const normalizedPath = sanitizePathForDiagnostics(current.path);
  if (normalizedPath && !Object.hasOwn(merged, 'path')) {
    merged.path = normalizedPath;
  }

  return merged;
}

// --- Perf Helpers ---

function toMs(nanos: number): number {
  return nanos / 1_000_000;
}

function getDelayStats(
  h: ReturnType<typeof monitorEventLoopDelay>
): NonNullable<PerfDiagnosticsEvent['eventLoopDelay']> | undefined {
  if (h.count === 0) return undefined;
  return {
    min: toMs(h.min),
    max: toMs(h.max),
    mean: toMs(h.mean),
    p50: toMs(h.percentile(50)),
    p95: toMs(h.percentile(95)),
    p99: toMs(h.percentile(99)),
    exceeds: h.exceeds,
  };
}

function clearPublishedMeasures(entries: readonly { name: string }[]): void {
  if (entries.length === 0) return;
  const names = new Set<string>();
  for (const entry of entries) {
    names.add(entry.name);
  }
  for (const name of names) {
    performance.clearMeasures(name);
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
  CHANNELS.ops.start.publish(normalizeContext(applyToolContext(context)));
}

export function publishOpsTraceEnd(context: OpsTraceContext): void {
  CHANNELS.ops.end.publish(normalizeContext(applyToolContext(context)));
}

export function publishOpsTraceError(
  context: OpsTraceContext,
  error: unknown
): void {
  CHANNELS.ops.error.publish({
    ...normalizeContext(applyToolContext(context)),
    error,
  });
}

function applyToolContext(context: OpsTraceContext): OpsTraceContext {
  const current = toolContext.getStore();
  if (!current) return context;

  const merged: OpsTraceContext = { ...context };
  merged.tool ??= current.tool;
  merged.path ??= current.path;
  return merged;
}

export function getToolContextSnapshot():
  | { tool: string; path?: string }
  | undefined {
  return toolContext.getStore();
}

export function getTraceContext(): TraceContext | undefined {
  return toolContext.getStore()?.traceContext;
}

function normalizeContext(ctx: OpsTraceContext): OpsTraceContext {
  if (!ctx.path) return ctx;
  const normalized = sanitizePathForDiagnostics(ctx.path);
  if (!normalized) {
    const copy = { ...ctx };
    delete copy.path;
    return copy;
  }
  return { ...ctx, path: normalized };
}

function clearMeasureMarks(startMark: string, endMark: string): void {
  performance.clearMarks(startMark);
  performance.clearMarks(endMark);
}

export function startPerfMeasure(
  name: string,
  detail?: Record<string, unknown>
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

function publishToolStart(
  tool: string,
  pathVal?: string,
  traceparent?: string
): void {
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
  traceparent?: string
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
  loopMonitor?: ReturnType<typeof monitorEventLoopDelay>
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

async function runAndObserve<T>(
  tool: string,
  run: () => Promise<T>,
  pubTool: boolean,
  pubPerf: boolean,
  logErrors: boolean,
  pathVal?: string,
  traceparent?: string
): Promise<T> {
  const startMs = performance.now();
  const eluStart = pubPerf ? performance.eventLoopUtilization() : undefined;
  const loopMonitor = pubPerf ? monitorEventLoopDelay() : undefined;
  loopMonitor?.enable();

  if (pubTool) publishToolStart(tool, pathVal, traceparent);

  let result: T;
  const obs = { ok: false, errorMsg: undefined as string | undefined };

  try {
    result = await run();
    const { ok, error } = extractOutcome(result);
    obs.ok = ok;
    obs.errorMsg = error;
  } catch (err) {
    obs.errorMsg = extractErrorMessage(err);
    throw err;
  } finally {
    const durationMs = performance.now() - startMs;
    loopMonitor?.disable();

    if (pubPerf && eluStart)
      publishPerfEnd(tool, durationMs, eluStart, loopMonitor);
    if (pubTool)
      publishToolEnd(tool, obs.ok, durationMs, obs.errorMsg, traceparent);

    updateMetrics(tool, obs.ok, durationMs);

    if (logErrors && !obs.ok) logError(tool, durationMs, obs.errorMsg);
  }

  return result;
}

export async function withToolDiagnostics<T>(
  tool: string,
  run: () => Promise<T>,
  options?: { path?: string; traceContext?: TraceContext }
): Promise<T> {
  const config = readConfig();
  const normalizedPath = sanitizePathForDiagnostics(options?.path);

  const context: ToolAsyncContext = {
    tool,
    ...(options?.path ? { path: options.path } : {}),
    ...(options?.traceContext ? { traceContext: options.traceContext } : {}),
  };

  return toolContext.run(context, async () => {
    if (!config.enabled) {
      if (!config.logToolErrors) return run();
      const start = performance.now();
      try {
        const res = await run();
        const { ok, error } = extractOutcome(res);
        if (!ok) logError(tool, performance.now() - start, error);
        return res;
      } catch (e) {
        logError(tool, performance.now() - start, extractErrorMessage(e));
        throw e;
      }
    }

    const pubTool = CHANNELS.tool.hasSubscribers;
    const pubPerf = CHANNELS.perf.hasSubscribers;

    if (!pubTool && !pubPerf) {
      const start = performance.now();
      try {
        const res = await run();
        const duration = performance.now() - start;
        const { ok } = extractOutcome(res);
        updateMetrics(tool, ok, duration);
        return res;
      } catch (e) {
        const duration = performance.now() - start;
        updateMetrics(tool, false, duration);
        throw e;
      }
    }

    return runAndObserve(
      tool,
      run,
      pubTool,
      pubPerf,
      config.logToolErrors,
      normalizedPath,
      options?.traceContext?.traceparent
    );
  });
}

function logError(tool: string, durationMs: number, msg?: string): void {
  const suffix = msg ? `: ${msg}` : '';
  Logger.error(
    `[ToolError] ${tool} failed in ${durationMs.toFixed(1)}ms${suffix}`
  );
}
