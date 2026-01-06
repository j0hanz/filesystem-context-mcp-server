import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';

type DiagnosticsDetail = 0 | 1 | 2;

interface ToolDiagnosticsEvent {
  phase: 'start' | 'end';
  tool: string;
  durationMs?: number;
  ok?: boolean;
  error?: string;
  path?: string;
}

const TOOL_CHANNEL = channel('filesystem-context:tool');

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

export async function withToolDiagnostics<T>(
  tool: string,
  run: () => Promise<T>,
  options?: { path?: string }
): Promise<T> {
  const enabled = parseDiagnosticsEnabled();
  if (!enabled || !TOOL_CHANNEL.hasSubscribers) {
    return await run();
  }

  const startNs = process.hrtime.bigint();
  TOOL_CHANNEL.publish({
    phase: 'start',
    tool,
    path: options?.path ? normalizePathForDiagnostics(options.path) : undefined,
  } satisfies ToolDiagnosticsEvent);

  try {
    const result = await run();
    const endNs = process.hrtime.bigint();
    const ok = resolveDiagnosticsOk(result);
    TOOL_CHANNEL.publish({
      phase: 'end',
      tool,
      ok: ok ?? true,
      durationMs: Number(endNs - startNs) / 1_000_000,
    } satisfies ToolDiagnosticsEvent);
    return result;
  } catch (error: unknown) {
    const endNs = process.hrtime.bigint();
    TOOL_CHANNEL.publish({
      phase: 'end',
      tool,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Number(endNs - startNs) / 1_000_000,
    } satisfies ToolDiagnosticsEvent);
    throw error;
  }
}
