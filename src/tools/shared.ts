import type {
  ContentBlock,
  ElicitRequestFormParams,
  ElicitResult,
  Icon,
  LoggingLevel,
  Notification,
  RequestMeta,
  RequestTaskStore,
  ServerContext,
} from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import { z } from 'zod/v4';

import { createTimedAbortSignal } from '../lib/abort.js';
import {
  createDetailedError,
  ErrorCode,
  formatDetailedError,
  getSuggestion,
  McpError,
} from '../lib/errors.js';
import type { MimeKind } from '../lib/mime.js';
import {
  type TraceContext,
  withToolDiagnostics,
} from '../lib/observability.js';
import type { PathGuard } from '../lib/path-guard.js';
import type { ResourceStore } from '../lib/resource-store.js';
import { createBase64JsonCodec } from '../lib/zod-codecs.js';

import type { FileInfo } from '../config.js';

export { type ToolContract } from './contract.js';

// W3C Trace Context: version-traceid-parentid-traceflags
const TRACEPARENT_RE = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/i;

function extractTraceContext(
  meta: ToolContext['_meta']
): TraceContext | undefined {
  const tp = meta?.traceparent;
  if (typeof tp !== 'string' || !TRACEPARENT_RE.test(tp)) return undefined;
  return {
    traceparent: tp,
    ...(typeof meta?.tracestate === 'string'
      ? { tracestate: meta.tracestate }
      : {}),
    ...(typeof meta?.baggage === 'string' ? { baggage: meta.baggage } : {}),
  };
}

export const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

export const DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  idempotentHint: false,
  destructiveHint: true,
  openWorldHint: false,
} as const;

export const IDEMPOTENT_WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

function normalizeToolExecution<T extends object>(tool: T): T {
  const candidate = tool as Record<string, unknown>;
  const topLevelTaskSupport = candidate.taskSupport;
  const existingExecution = getExecutionConfigForToolNormalization(candidate);
  const resolvedTaskSupport = resolveTaskSupportForNormalization(
    topLevelTaskSupport,
    existingExecution?.taskSupport
  );

  if (resolvedTaskSupport === undefined && topLevelTaskSupport === undefined) {
    return tool;
  }

  const normalized = { ...candidate };
  delete normalized.taskSupport;

  const execution = buildNormalizedExecutionForTool(
    existingExecution,
    resolvedTaskSupport
  );
  if (execution !== undefined) {
    normalized.execution = execution;
  }

  return normalized as T;
}

function getExecutionConfigForToolNormalization(
  candidate: Record<string, unknown>
): Record<string, unknown> | undefined {
  const { execution } = candidate;
  return execution && typeof execution === 'object'
    ? (execution as Record<string, unknown>)
    : undefined;
}

function resolveTaskSupportForNormalization(
  topLevelTaskSupport: unknown,
  executionTaskSupport: unknown
): string | undefined {
  if (
    topLevelTaskSupport === 'optional' ||
    topLevelTaskSupport === 'required' ||
    topLevelTaskSupport === 'forbidden'
  ) {
    return topLevelTaskSupport;
  }

  if (
    executionTaskSupport === 'optional' ||
    executionTaskSupport === 'required' ||
    executionTaskSupport === 'forbidden'
  ) {
    return executionTaskSupport;
  }

  return undefined;
}

function buildNormalizedExecutionForTool(
  existingExecution: Record<string, unknown> | undefined,
  taskSupport: string | undefined
): Record<string, unknown> | undefined {
  if (taskSupport === undefined && existingExecution === undefined) {
    return undefined;
  }

  return {
    ...(existingExecution ?? {}),
    ...(taskSupport !== undefined ? { taskSupport } : {}),
  };
}

export function buildResourceLink(params: {
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
  expiresAt?: string;
}): ContentBlock {
  const descParts: string[] = [];
  if (params.description) descParts.push(params.description);
  if (params.expiresAt) descParts.push(`Expires: ${params.expiresAt}`);
  const description = descParts.length > 0 ? descParts.join(' · ') : undefined;
  return {
    type: 'resource_link',
    uri: params.uri,
    name: params.name,
    ...(description ? { description } : {}),
    ...(params.mimeType ? { mimeType: params.mimeType } : {}),
  };
}

function resolveDetailedError(
  error: unknown,
  defaultCode: ErrorCode,
  path?: string
): {
  code: ErrorCode;
  message: string;
  path?: string;
  suggestion?: string;
  details?: Record<string, unknown>;
} {
  const detailed = createDetailedError(error, path);
  if (
    detailed.code === ErrorCode.UNKNOWN ||
    detailed.code === ErrorCode.IO_ERROR
  ) {
    detailed.code = defaultCode;
    const suggestion = getSuggestion(defaultCode);
    if (suggestion) {
      detailed.suggestion = suggestion;
    }
  }
  return detailed;
}

export function buildStructuredError(
  error: unknown,
  defaultCode: ErrorCode,
  path?: string
): {
  code: ErrorCode;
  message: string;
  path?: string;
  suggestion?: string;
} {
  const detailed = resolveDetailedError(error, defaultCode, path);
  return {
    code: detailed.code,
    message: detailed.message,
    ...(detailed.path !== undefined ? { path: detailed.path } : {}),
    ...(detailed.suggestion !== undefined
      ? { suggestion: detailed.suggestion }
      : {}),
  };
}

export function buildToolResponse<T>(
  text: string,
  structuredContent: T,
  extraContent: ContentBlock[] = []
): {
  content: ContentBlock[];
  structuredContent: T;
} {
  return {
    content: [{ type: 'text', text }, ...extraContent],
    structuredContent,
  };
}

export type ToolResponse<T> = ReturnType<typeof buildToolResponse<T>> & {
  isError?: never;
} & Record<string, unknown>;

interface ToolErrorResponse extends Record<string, unknown> {
  content: ContentBlock[];
  isError: true;
  errorCode: ErrorCode;
}

export type ToolResult<T> = ToolResponse<T> | ToolErrorResponse;

function validateStructuredContent<T>(
  toolName: string,
  outputSchema: z.ZodType<T>,
  structuredContent: unknown
): T {
  const parsed = outputSchema.safeParse(structuredContent);
  if (parsed.success) {
    return parsed.data;
  }

  throw new McpError(
    ErrorCode.UNKNOWN,
    `Tool "${toolName}" returned invalid structuredContent.`,
    undefined,
    { errors: z.treeifyError(parsed.error) }
  );
}

function validateToolResponse<T>(
  toolName: string,
  result: ToolResponse<T>,
  outputSchema?: z.ZodType<T>
): ToolResponse<T> {
  if (!outputSchema) return result;
  if (!Object.hasOwn(result, 'structuredContent')) {
    throw new McpError(
      ErrorCode.UNKNOWN,
      `Tool "${toolName}" returned success without structuredContent.`
    );
  }

  return {
    ...result,
    structuredContent: validateStructuredContent(
      toolName,
      outputSchema,
      result.structuredContent
    ),
  };
}

/**
 * App-level tracing metadata passed through {@linkcode RequestMeta}.
 * These fields are preserved by the SDK's loose `RequestMeta` type.
 */
interface TracingMeta {
  traceparent?: string | undefined;
  tracestate?: string | undefined;
  baggage?: string | undefined;
}

export interface ToolContext {
  signal?: AbortSignal;
  sessionId?: string;
  _meta?: (RequestMeta & TracingMeta) | undefined;
  sendNotification?: (notification: Notification) => Promise<void>;
  log?: (level: LoggingLevel, data: unknown, logger?: string) => Promise<void>;
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
}

/**
 * `ToolContext` augmented with optional task-execution metadata. Populated by
 * the task handler in `task-support.ts`; absent for non-task tool calls.
 */
export type TaskToolContext = ToolContext & {
  taskId?: string;
  taskStore?: RequestTaskStore;
  taskRequestedTtl?: number;
};

export function toToolContext(ctx?: ToolContext | ServerContext): ToolContext {
  if (!ctx) return {};
  if ('mcpReq' in ctx) {
    return {
      signal: ctx.mcpReq.signal,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.mcpReq._meta ? { _meta: ctx.mcpReq._meta } : {}),
      sendNotification: async (notification) => ctx.mcpReq.notify(notification),
      log: async (level, data, logger) => ctx.mcpReq.log(level, data, logger),
      elicitInput: (params) => ctx.mcpReq.elicitInput(params),
    };
  }
  return ctx;
}

/**
 * Handler context for tool run functions. Contains only the fields that handlers
 * actually need, decoupled from MCP transport internals like _meta and sessionId.
 */
export interface HandlerContext {
  signal?: AbortSignal;
  pathGuard: PathGuard;
  resourceStore: ResourceStore | undefined;
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
  log?: (level: LoggingLevel, data: unknown, logger?: string) => Promise<void>;
  onProgress?: (params: {
    current: number;
    total?: number;
    message?: string;
  }) => void;
}

export interface IconInfo {
  src: string;
  mimeType: string;
}

export function withDefaultIcons<T extends object>(
  tool: T,
  iconInfo: IconInfo | undefined
): T & { icons?: Icon[] } {
  const normalizedTool = normalizeToolExecution(tool);
  if (!iconInfo) {
    return normalizedTool;
  }

  const existingIcons = (normalizedTool as { icons?: Icon[] }).icons;
  if (existingIcons && existingIcons.length > 0) {
    return normalizedTool;
  }

  const withIcons = {
    ...normalizedTool,
    icons: [
      {
        src: iconInfo.src,
        mimeType: iconInfo.mimeType,
      },
    ],
  };
  return withIcons;
}

export interface ToolRegistrationOptions {
  pathGuard: PathGuard;
  resourceStore?: ResourceStore;
  isInitialized?: () => boolean;
  hasTaskSupport?: boolean;
  serverIcon?: string;
  iconInfo?: IconInfo;
}

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
    ...(info.tokenEstimate !== undefined
      ? { tokenEstimate: info.tokenEstimate }
      : {}),
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    accessed: info.accessed.toISOString(),
    permissions: info.permissions,
    isHidden: info.isHidden,
    ...(info.mimeType !== undefined ? { mimeType: info.mimeType } : {}),
    ...(info.symlinkTarget !== undefined
      ? { symlinkTarget: info.symlinkTarget }
      : {}),
  };
}

async function withToolErrorHandling<T>(
  run: () => Promise<ToolResult<T>>,
  onError: (error: unknown) => ToolResult<T>
): Promise<ToolResult<T>> {
  try {
    return await run();
  } catch (error) {
    return onError(error);
  }
}

interface ToolExecutionOptions<T> {
  toolName: string;
  ctx: ToolContext;
  outputSchema?: z.ZodType<T>;
  run: (
    signal: AbortSignal | undefined
  ) => ToolResult<T> | Promise<ToolResult<T>>;
  onError: (error: unknown) => ToolResult<T>;
  context?: Record<string, unknown>;
  timedSignal?: {
    timeoutMs?: number;
  };
}

function getToolSignal(
  extraSignal: AbortSignal | undefined,
  timedSignal: ToolExecutionOptions<unknown>['timedSignal']
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (!timedSignal) {
    return { signal: extraSignal, cleanup: () => undefined };
  }

  const { signal, cleanup } = createTimedAbortSignal(
    extraSignal,
    timedSignal.timeoutMs
  );
  return { signal, cleanup };
}

export async function executeToolWithDiagnostics<T>(
  options: ToolExecutionOptions<T>
): Promise<ToolResult<T>> {
  const traceContext = extractTraceContext(options.ctx._meta);
  return withToolDiagnostics(
    options.toolName,
    () =>
      withToolErrorHandling(async () => {
        const { signal, cleanup } = getToolSignal(
          options.ctx.signal,
          options.timedSignal
        );
        try {
          const rawResult = await options.run(signal);
          // If run() returned a ToolErrorResponse directly, skip output validation.
          if (!Object.hasOwn(rawResult, 'structuredContent')) {
            return rawResult;
          }
          return validateToolResponse(
            options.toolName,
            rawResult as ToolResponse<T>,
            options.outputSchema
          );
        } finally {
          cleanup();
        }
      }, options.onError),
    {
      ...options.context,
      ...(traceContext ? { traceContext } : {}),
    }
  );
}

export function buildToolErrorResponse(
  error: unknown,
  defaultCode: ErrorCode,
  path?: string
): ToolErrorResponse {
  const detailed = resolveDetailedError(error, defaultCode, path);
  const text = formatDetailedError(detailed);
  return {
    content: [{ type: 'text', text }],
    isError: true,
    errorCode: detailed.code,
  };
}

const OffsetCursorSchema = z.strictObject({
  offset: z.int().min(0),
});

const OffsetCursorCodec = createBase64JsonCodec(OffsetCursorSchema);

export function encodeOffsetCursor(offset: number): string {
  return z.encode(OffsetCursorCodec, { offset });
}

export function decodeOffsetCursor(cursor: string): number {
  try {
    return OffsetCursorCodec.parse(cursor).offset;
  } catch {
    // fall through to throw
  }
  throw new McpError(
    ErrorCode.INVALID_INPUT,
    `Invalid cursor. Request the first page without a cursor.`
  );
}

export function buildBatchPathContext(
  paths: readonly string[],
  unitLabel = 'paths'
): string {
  const normalizedLabel =
    paths.length === 1 ? unitLabel.replace(/s$/i, '') : unitLabel;
  const first = basename(paths[0] ?? '');
  let extraPaths = '';
  if (paths.length > 1) {
    const secondPath = basename(paths[1] ?? '');
    const ellipsis = paths.length > 2 ? '…' : '';
    extraPaths = `, ${secondPath}${ellipsis}`;
  }
  return `${paths.length} ${normalizedLabel} [${first}${extraPaths}]`;
}

export function truncateProgressPattern(
  pattern: string,
  maxLength = 40
): string {
  if (pattern.length <= maxLength) return pattern;
  if (pattern.includes('|')) {
    const segments = pattern.split('|');
    const first = segments[0] ?? '';
    const second = segments[1];
    const preview = second !== undefined ? `${first}|${second}` : first;
    return preview.length <= maxLength
      ? `${preview}…`
      : `${preview.slice(0, maxLength)}…`;
  }
  return `${pattern.slice(0, maxLength)}…`;
}

/**
 * @deprecated Removed in resource-store-first refactor. Use putResource instead.
 */
export function maybeExternalizeTextContent(
  _resourceStore?: ResourceStore,
  _content?: string,
  _params?: { name: string; mimeType?: string }
):
  | {
      entry: {
        uri: string;
        name: string;
        size: number;
        mimeType: string;
        expiresAt: string;
      };
      preview: string;
    }
  | undefined {
  return undefined;
}

interface BuildResourceResponseParams<T> {
  summary: string;
  resources: ContentBlock[];
  structured: T;
}

interface PutResourceParams {
  store: ResourceStore;
  name: string;
  mimeType: string;
  kind: MimeKind;
  content: string | Buffer;
  audience?: ('user' | 'assistant')[];
  title?: string;
  description?: string;
}

interface PutResourceResult {
  entry: { uri: string; size: number; mimeType: string; expiresAt: string };
  link: ContentBlock;
}

export function buildResourceResponse<T>(
  params: BuildResourceResponseParams<T>
): {
  content: ContentBlock[];
  structuredContent: T;
} {
  return {
    content: [{ type: 'text', text: params.summary }, ...params.resources],
    structuredContent: params.structured,
  };
}

function buildLinkBlock(
  uri: string,
  name: string,
  mimeType: string,
  size: number,
  params?: {
    audience?: ('user' | 'assistant')[];
    title?: string;
    description?: string;
  }
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
    annotations: {
      audience,
    },
  };
}

export function putResource(params: PutResourceParams): PutResourceResult {
  const entry =
    params.kind === 'text'
      ? params.store.putText({
          name: params.name,
          mimeType: params.mimeType,
          text:
            typeof params.content === 'string'
              ? params.content
              : params.content.toString('utf-8'),
        })
      : params.store.putBlob({
          name: params.name,
          mimeType: params.mimeType,
          data: Buffer.isBuffer(params.content)
            ? params.content
            : Buffer.from(params.content),
        });

  const linkParams = {
    ...(params.audience !== undefined ? { audience: params.audience } : {}),
    ...(params.title !== undefined ? { title: params.title } : {}),
    ...(params.description !== undefined
      ? { description: params.description }
      : {}),
  };

  const link = buildLinkBlock(
    entry.uri,
    entry.name,
    entry.mimeType,
    entry.size,
    linkParams
  );

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
