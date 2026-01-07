import { createHash } from 'node:crypto';
import { channel, tracingChannel } from 'node:diagnostics_channel';

import {
  captureEventLoopUtilization,
  diffEventLoopUtilization,
} from './perf.js';

type DiagnosticsDetail = 0 | 1 | 2;

interface ToolDiagnosticsEvent {
  phase: 'start' | 'end';
  tool: string;
  durationMs?: number;
  ok?: boolean;
  error?: string;
  path?: string;
}

interface PerfDiagnosticsEvent {
  phase: 'end';
  tool: string;
  durationMs: number;
  elu: {
    idle: number;
    active: number;
    utilization: number;
  };
}

export interface OpsTraceContext {
  op: string;
  engine?: string;
  tool?: string;
  path?: string;
  [key: string]: unknown;
}

const TOOL_CHANNEL = channel('filesystem-context:tool');
const PERF_CHANNEL = channel('filesystem-context:perf');
const OPS_TRACE = tracingChannel<unknown, OpsTraceContext>(
  'filesystem-context:ops'
);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasBooleanOk(value: unknown): value is { ok: boolean } {
  return isObject(value) && typeof value.ok === 'boolean';
}

function resolveDiagnosticsOk(result: unknown): boolean | undefined {
  if (!isObject(result)) return undefined;
  if (result.isError === true) return false;
  if (hasBooleanOk(result)) return result.ok;

  const structured = result.structuredContent;
  if (hasBooleanOk(structured)) return structured.ok;

  return undefined;
}

function parseDiagnosticsEnabled(): boolean {
  const raw = process.env.FILESYSTEM_CONTEXT_DIAGNOSTICS;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parseDiagnosticsDetail(): DiagnosticsDetail {
  const raw = process.env.FILESYSTEM_CONTEXT_DIAGNOSTICS_DETAIL;
  if (!raw) return 0;
  const normalized = raw.trim();
  if (normalized === '2') return 2;
  if (normalized === '1') return 1;
  return 0;
}

function hashPath(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function normalizePathForDiagnostics(path: string): string | undefined {
  const detail = parseDiagnosticsDetail();
  if (detail === 0) return undefined;
  if (detail === 2) return path;
  return hashPath(path);
}

function resolveDiagnosticsPath(options?: {
  path?: string;
}): string | undefined {
  return options?.path ? normalizePathForDiagnostics(options.path) : undefined;
}

function normalizeOpsTraceContext(context: OpsTraceContext): OpsTraceContext {
  if (!context.path) return context;
  return {
    ...context,
    path: normalizePathForDiagnostics(context.path),
  };
}

function resolveDurationMsFrom(startNs: bigint, endNs: bigint): number {
  return Number(endNs - startNs) / 1_000_000;
}

function resolvePrimitiveErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (typeof error === 'number' || typeof error === 'boolean') {
    return String(error);
  }
  if (typeof error === 'bigint') return error.toString();
  if (typeof error === 'symbol') return error.description ?? 'symbol';
  return undefined;
}

function resolveObjectErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (isObject(error) && typeof error.message === 'string') {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return undefined;
  }
}

function resolveDiagnosticsErrorMessage(error?: unknown): string | undefined {
  if (!error) return undefined;
  return (
    resolvePrimitiveErrorMessage(error) ?? resolveObjectErrorMessage(error)
  );
}

function publishStartEvent(tool: string, options?: { path?: string }): void {
  TOOL_CHANNEL.publish({
    phase: 'start',
    tool,
    path: resolveDiagnosticsPath(options),
  } satisfies ToolDiagnosticsEvent);
}

function publishEndEvent(
  tool: string,
  ok: boolean,
  durationMs: number,
  error?: unknown
): void {
  TOOL_CHANNEL.publish({
    phase: 'end',
    tool,
    ok,
    error: resolveDiagnosticsErrorMessage(error),
    durationMs,
  } satisfies ToolDiagnosticsEvent);
}

function publishPerfEndEvent(
  tool: string,
  durationMs: number,
  elu: ReturnType<typeof diffEventLoopUtilization>
): void {
  PERF_CHANNEL.publish({
    phase: 'end',
    tool,
    durationMs,
    elu: {
      idle: elu.idle,
      active: elu.active,
      utilization: elu.utilization,
    },
  } satisfies PerfDiagnosticsEvent);
}

export function shouldPublishOpsTrace(): boolean {
  return parseDiagnosticsEnabled() && OPS_TRACE.hasSubscribers;
}

export function publishOpsTraceStart(context: OpsTraceContext): void {
  OPS_TRACE.start.publish(normalizeOpsTraceContext(context));
}

export function publishOpsTraceEnd(context: OpsTraceContext): void {
  OPS_TRACE.end.publish(normalizeOpsTraceContext(context));
}

export function publishOpsTraceError(
  context: OpsTraceContext,
  error: unknown
): void {
  OPS_TRACE.error.publish({
    ...normalizeOpsTraceContext(context),
    error,
  });
}

export async function withToolDiagnostics<T>(
  tool: string,
  run: () => Promise<T>,
  options?: { path?: string }
): Promise<T> {
  const enabled = parseDiagnosticsEnabled();
  if (!enabled) {
    return await run();
  }

  const shouldPublishTool = TOOL_CHANNEL.hasSubscribers;
  const shouldPublishPerf = PERF_CHANNEL.hasSubscribers;
  if (!shouldPublishTool && !shouldPublishPerf) {
    return await run();
  }

  const startNs = process.hrtime.bigint();
  const eluStart = shouldPublishPerf
    ? captureEventLoopUtilization()
    : undefined;
  if (shouldPublishTool) publishStartEvent(tool, options);

  try {
    const result = await run();
    const endNs = process.hrtime.bigint();
    const durationMs = resolveDurationMsFrom(startNs, endNs);
    if (shouldPublishPerf && eluStart) {
      publishPerfEndEvent(tool, durationMs, diffEventLoopUtilization(eluStart));
    }
    if (shouldPublishTool) {
      publishEndEvent(tool, resolveDiagnosticsOk(result) ?? true, durationMs);
    }
    return result;
  } catch (error: unknown) {
    const endNs = process.hrtime.bigint();
    const durationMs = resolveDurationMsFrom(startNs, endNs);
    if (shouldPublishPerf && eluStart) {
      publishPerfEndEvent(tool, durationMs, diffEventLoopUtilization(eluStart));
    }
    if (shouldPublishTool) {
      publishEndEvent(tool, false, durationMs, error);
    }
    throw error;
  }
}
