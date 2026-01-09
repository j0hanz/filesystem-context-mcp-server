import { createHash } from 'node:crypto';
import { channel, tracingChannel } from 'node:diagnostics_channel';

import {
  resolveDiagnosticsErrorMessage,
  resolveDiagnosticsOk,
} from './diagnostics-helpers.js';
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

const TOOL_CHANNEL = channel('fs-context:tool');
const PERF_CHANNEL = channel('fs-context:perf');
const OPS_TRACE = tracingChannel<unknown, OpsTraceContext>('fs-context:ops');

function parseDiagnosticsEnabled(): boolean {
  const normalized = process.env.FS_CONTEXT_DIAGNOSTICS?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parseDiagnosticsDetail(): DiagnosticsDetail {
  const normalized = process.env.FS_CONTEXT_DIAGNOSTICS_DETAIL?.trim();
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

function normalizeOpsTraceContext(context: OpsTraceContext): OpsTraceContext {
  if (!context.path) return context;
  const normalizedPath = normalizePathForDiagnostics(context.path);
  if (!normalizedPath) {
    const sanitized: OpsTraceContext = { ...context };
    delete sanitized.path;
    return sanitized;
  }
  return { ...context, path: normalizedPath };
}

function publishStartEvent(tool: string, options?: { path?: string }): void {
  const event: ToolDiagnosticsEvent = { phase: 'start', tool };
  const normalizedPath = options?.path
    ? normalizePathForDiagnostics(options.path)
    : undefined;
  if (normalizedPath !== undefined) {
    event.path = normalizedPath;
  }
  TOOL_CHANNEL.publish(event);
}

function publishEndEvent(
  tool: string,
  ok: boolean,
  durationMs: number,
  error?: unknown
): void {
  const event: ToolDiagnosticsEvent = {
    phase: 'end',
    tool,
    ok,
    durationMs,
  };
  const message = resolveDiagnosticsErrorMessage(error);
  if (message !== undefined) {
    event.error = message;
  }
  TOOL_CHANNEL.publish(event);
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

function startToolDiagnostics(
  tool: string,
  options: { path?: string } | undefined,
  shouldPublishTool: boolean,
  shouldPublishPerf: boolean
): {
  startNs: bigint;
  eluStart: ReturnType<typeof captureEventLoopUtilization> | undefined;
} {
  const startNs = process.hrtime.bigint();
  const eluStart = shouldPublishPerf
    ? captureEventLoopUtilization()
    : undefined;
  if (shouldPublishTool) publishStartEvent(tool, options);
  return { startNs, eluStart };
}

function finalizeToolDiagnostics(
  tool: string,
  startNs: bigint,
  options: {
    ok: boolean;
    error?: unknown;
    shouldPublishTool: boolean;
    shouldPublishPerf: boolean;
    eluStart: ReturnType<typeof captureEventLoopUtilization> | undefined;
  }
): void {
  const endNs = process.hrtime.bigint();
  const durationMs = Number(endNs - startNs) / 1_000_000;
  if (options.shouldPublishPerf && options.eluStart) {
    publishPerfEndEvent(
      tool,
      durationMs,
      diffEventLoopUtilization(options.eluStart)
    );
  }
  if (options.shouldPublishTool) {
    publishEndEvent(tool, options.ok, durationMs, options.error);
  }
}

async function runWithDiagnostics<T>(
  tool: string,
  run: () => Promise<T>,
  options: { path?: string } | undefined,
  shouldPublishTool: boolean,
  shouldPublishPerf: boolean
): Promise<T> {
  const { startNs, eluStart } = startToolDiagnostics(
    tool,
    options,
    shouldPublishTool,
    shouldPublishPerf
  );
  const finalizeOptions = { shouldPublishTool, shouldPublishPerf, eluStart };
  try {
    const result = await run();
    finalizeToolDiagnostics(tool, startNs, {
      ok: resolveDiagnosticsOk(result) ?? true,
      ...finalizeOptions,
    });
    return result;
  } catch (error: unknown) {
    finalizeToolDiagnostics(tool, startNs, {
      ok: false,
      error,
      ...finalizeOptions,
    });
    throw error;
  }
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
  if (!parseDiagnosticsEnabled()) {
    return await run();
  }

  const shouldPublishTool = TOOL_CHANNEL.hasSubscribers;
  const shouldPublishPerf = PERF_CHANNEL.hasSubscribers;
  if (!shouldPublishTool && !shouldPublishPerf) {
    return await run();
  }

  return await runWithDiagnostics(
    tool,
    run,
    options,
    shouldPublishTool,
    shouldPublishPerf
  );
}
