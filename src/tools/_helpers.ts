// src/tools/_helpers.ts
// Shared runtime helpers for tool implementations.
import type {
  ContentBlock,
  ElicitRequestFormParams,
  ElicitResult,
  Icon,
  LoggingLevel,
  Notification,
  RequestMeta,
  Role,
  ServerContext,
} from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

import type { FileInfo } from '../config.js';
import { ErrorCode, McpError } from '../core/errors.js';
import type { MimeKind } from '../core/fs.js';
import type { PathGuard } from '../core/path.js';
import { createBase64JsonCodec } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { NonNegInt } from '../schema.js';
import type { TaskOrchestrator } from '../tasks.js';

// ============ ToolContext ============

/**
 * W3C Trace Context metadata as carried on MCP `_meta`. Wire keys use
 * io.opentelemetry/ namespace per MCP spec for third-party key namespacing.
 */
interface TracingMeta {
  'io.opentelemetry/traceparent'?: string | undefined;
  'io.opentelemetry/tracestate'?: string | undefined;
  'io.opentelemetry/baggage'?: string | undefined;
}

export interface ToolContext {
  signal?: AbortSignal;
  sessionId?: string;
  _meta?: (RequestMeta & TracingMeta) | undefined;
  task?: ServerContext['task'];
  sendNotification?: (notification: Notification) => Promise<void>;
  onProgress?: (params: { current: number; total?: number }) => void;
  log?: (level: LoggingLevel, data: unknown, logger?: string) => Promise<void>;
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
}

// ============ ToolRegistrationOptions ============

/**
 * Minimal icon descriptor used internally. Compatible with SDK's `Icon`
 * (which has optional mimeType, sizes, theme). We require mimeType for
 * consistency with our single icon producer.
 */
export type IconInfo = Icon & { mimeType: string };

type TaskSupport = 'optional' | 'required' | 'forbidden';

export interface ToolRegistrationOptions {
  pathGuard: PathGuard;
  resourceStore?: ResourceStore;
  isInitialized?: () => boolean;
  orchestrator?: TaskOrchestrator | undefined;
}

// ============ Formatting ============

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const KIB_LOCAL = 1024;
  const MIB_LOCAL = 1024 * 1024;
  const GIB_LOCAL = 1024 * 1024 * 1024;
  if (bytes < KIB_LOCAL) return `${bytes} B`;
  if (bytes < MIB_LOCAL) return `${(bytes / KIB_LOCAL).toFixed(1)} KB`;
  if (bytes < GIB_LOCAL) return `${(bytes / MIB_LOCAL).toFixed(1)} MB`;
  return `${(bytes / GIB_LOCAL).toFixed(1)} GB`;
}

// ============ Resource Store Helpers ============

interface PutResourceParams {
  store: ResourceStore;
  name: string;
  mimeType: string;
  kind: MimeKind;
  content: string | Buffer;
  audience?: Role[];
  title?: string;
  description?: string;
}

interface PutResourceResult {
  entry: { uri: string; size: number; mimeType: string; expiresAt: string };
  link: ContentBlock;
}

function buildLinkBlock(
  uri: string,
  name: string,
  mimeType: string,
  size: number,
  params?: {
    audience?: Role[];
    title?: string;
    description?: string;
  },
): ContentBlock {
  const audience = params?.audience ?? ['user'];
  return {
    type: 'resource_link',
    uri,
    name,
    mimeType,
    size,
    ...(params?.title ? { title: params.title } : {}),
    ...(params?.description ? { description: params.description } : {}),
    annotations: { audience },
  };
}

export function putResource(params: PutResourceParams): PutResourceResult {
  const entry =
    params.kind === 'text'
      ? params.store.putText({
          name: params.name,
          mimeType: params.mimeType,
          text:
            typeof params.content === 'string' ? params.content : params.content.toString('utf-8'),
        })
      : params.store.putBlob({
          name: params.name,
          mimeType: params.mimeType,
          data: Buffer.isBuffer(params.content) ? params.content : Buffer.from(params.content),
        });

  const linkParams = {
    ...(params.audience !== undefined ? { audience: params.audience } : {}),
    ...(params.title !== undefined ? { title: params.title } : {}),
    ...(params.description !== undefined ? { description: params.description } : {}),
  };

  const link = buildLinkBlock(entry.uri, entry.name, entry.mimeType, entry.size, linkParams);

  return {
    entry: {
      uri: entry.uri,
      size: entry.size,
      mimeType: entry.mimeType,
      expiresAt: entry.expiresAt,
    },
    link,
  };
}

// ============ Cursor Helpers ============

const OffsetCursorSchema = z.strictObject({
  offset: NonNegInt,
});

const OffsetCursorCodec = createBase64JsonCodec(OffsetCursorSchema);

export function encodeOffsetCursor(offset: number): string {
  return z.encode(OffsetCursorCodec, { offset });
}

export function decodeOffsetCursor(cursor: string): number {
  try {
    const result = OffsetCursorCodec.safeParse(cursor);
    if (!result.success) {
      throw new McpError(
        ErrorCode.INVALID_INPUT,
        `Invalid cursor. Request the first page without a cursor.`,
      );
    }
    return result.data.offset;
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.INVALID_INPUT,
      `Invalid cursor. Request the first page without a cursor.`,
    );
  }
}

export function truncateProgressPattern(pattern: string, maxLength = 40): string {
  if (pattern.length <= maxLength) return pattern;
  if (pattern.includes('|')) {
    const segments = pattern.split('|');
    const first = segments[0] ?? '';
    const second = segments[1];
    const preview = second !== undefined ? `${first}|${second}` : first;
    return preview.length <= maxLength ? `${preview}…` : `${preview.slice(0, maxLength)}…`;
  }
  return `${pattern.slice(0, maxLength)}…`;
}

// ============ FileInfo Helper ============

interface FileInfoPayload {
  name: string;
  path: string;
  type: FileInfo['type'];
  size: number;
  tokenEstimate?: number;
  created: string;
  modified: string;
  accessed: string;
  permissions: string;
  isHidden: boolean;
  mimeType?: string;
  symlinkTarget?: string;
}

export function buildFileInfoPayload(info: FileInfo): FileInfoPayload {
  return {
    name: info.name,
    path: info.path,
    type: info.type,
    size: info.size,
    ...(info.tokenEstimate !== undefined ? { tokenEstimate: info.tokenEstimate } : {}),
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    accessed: info.accessed.toISOString(),
    permissions: info.permissions,
    isHidden: info.isHidden,
    ...(info.mimeType !== undefined ? { mimeType: info.mimeType } : {}),
    ...(info.symlinkTarget !== undefined ? { symlinkTarget: info.symlinkTarget } : {}),
  };
}

// ---- Icon helpers ----

function normalizeToolExecution<T extends object>(tool: T): T {
  const candidate = tool as Record<string, unknown>;
  const topLevelTaskSupport = candidate['taskSupport'];
  const existingExecution = getExecutionConfig(candidate);
  const resolvedTaskSupport = resolveTaskSupport(
    topLevelTaskSupport,
    existingExecution?.['taskSupport'],
  );

  if (resolvedTaskSupport === undefined && topLevelTaskSupport === undefined) {
    return tool;
  }

  const normalized = { ...candidate };
  delete normalized['taskSupport'];

  const execution = buildExecution(existingExecution, resolvedTaskSupport);
  if (execution !== undefined) {
    normalized['execution'] = execution;
  }

  return normalized as T;
}

function getExecutionConfig(
  candidate: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const { execution } = candidate;
  return execution && typeof execution === 'object'
    ? (execution as Record<string, unknown>)
    : undefined;
}

function resolveTaskSupport(topLevel: unknown, nested: unknown): TaskSupport | undefined {
  if (topLevel === 'optional' || topLevel === 'required' || topLevel === 'forbidden') {
    return topLevel;
  }
  if (nested === 'optional' || nested === 'required' || nested === 'forbidden') {
    return nested;
  }
  return undefined;
}

function buildExecution(
  existing: Record<string, unknown> | undefined,
  taskSupport: TaskSupport | undefined,
): Record<string, unknown> | undefined {
  if (taskSupport === undefined && existing === undefined) return undefined;
  return {
    ...(existing ?? {}),
    ...(taskSupport !== undefined ? { taskSupport } : {}),
  };
}

export function withDefaultIcons<T extends object>(
  tool: T,
  iconInfo: IconInfo | undefined,
): T & { icons?: Icon[] } {
  const normalized = normalizeToolExecution(tool);
  if (!iconInfo) return normalized;
  const existing = (normalized as { icons?: Icon[] }).icons;
  if (existing && existing.length > 0) return normalized;
  return { ...normalized, icons: [{ src: iconInfo.src, mimeType: iconInfo.mimeType }] };
}

// ---- ToolResult ----

type ToolResponse<T> = {
  content: ContentBlock[];
  structuredContent: T;
  isError?: never;
} & Record<string, unknown>;

interface ToolErrorResponse extends Record<string, unknown> {
  content: ContentBlock[];
  isError: true;
  errorCode: ErrorCode;
}

export type ToolResult<T> = ToolResponse<T> | ToolErrorResponse;

export function toToolContext(ctx?: ToolContext | ServerContext): ToolContext {
  if (!ctx) return {};
  if ('mcpReq' in ctx) {
    return {
      signal: ctx.mcpReq.signal,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.mcpReq._meta ? { _meta: ctx.mcpReq._meta } : {}),
      ...(ctx.task ? { task: ctx.task } : {}),
      sendNotification: async (notification) => ctx.mcpReq.notify(notification),
      log: async (level, data, logger) => ctx.mcpReq.log(level, data, logger),
      elicitInput: (params) => ctx.mcpReq.elicitInput(params),
    };
  }
  return ctx;
}
