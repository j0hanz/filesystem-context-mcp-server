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

import { channel } from 'node:diagnostics_channel';
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
import { Logger } from '../lib/logger.js';
import {
  type TraceContext,
  withToolDiagnostics,
} from '../lib/observability.js';
import type { PathGuard } from '../lib/path-guard.js';
import { getAllowedDirectories } from '../lib/paths.js';
import type { ResourceStore } from '../lib/resource-store.js';
import { createBase64JsonCodec } from '../lib/zod-codecs.js';

import type { FileInfo } from '../config.js';

export { type ToolContract } from './contract.js';

const MAX_INLINE_CONTENT_CHARS =
  parseInt(process.env.FS_CONTEXT_MAX_INLINE_CHARS ?? '', 10) || 20_000;
const MAX_INLINE_PREVIEW_CHARS = MAX_INLINE_CONTENT_CHARS;

interface ContextDiagnosticsEvent {
  phase: 'externalize_text';
  name: string;
  mimeType?: string;
  chars: number;
  uri: string;
}

const CONTEXT_DIAGNOSTICS_CHANNEL = channel('filesystem-mcp:context');

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

function publishContextDiagnostics(event: ContextDiagnosticsEvent): void {
  if (!CONTEXT_DIAGNOSTICS_CHANNEL.hasSubscribers) return;
  CONTEXT_DIAGNOSTICS_CHANNEL.publish(event);
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

function maybeStripOutputSchema<T extends object>(tool: T): T {
  if (!Object.hasOwn(tool, 'outputSchema')) return tool;

  const stripped = Object.fromEntries(
    Object.entries(tool as Record<string, unknown>).filter(
      ([key]) => key !== 'outputSchema'
    )
  );
  return stripped as T;
}

type ResourceEntry = ReturnType<ResourceStore['putText']>;

function buildTextPreview(text: string): string {
  if (text.length <= MAX_INLINE_PREVIEW_CHARS) return text;
  return `${text.slice(0, MAX_INLINE_PREVIEW_CHARS)}\n… [truncated preview]`;
}

export function maybeExternalizeTextContent(
  resourceStore: ResourceStore | undefined,
  content: string,
  params: { name: string; mimeType?: string }
): { entry: ResourceEntry; preview: string } | undefined {
  if (!resourceStore) return undefined;
  if (content.length <= MAX_INLINE_CONTENT_CHARS) return undefined;

  const entry = resourceStore.putText({
    name: params.name,
    ...(params.mimeType !== undefined ? { mimeType: params.mimeType } : {}),
    text: content,
  });

  publishContextDiagnostics({
    phase: 'externalize_text',
    name: params.name,
    ...(params.mimeType !== undefined ? { mimeType: params.mimeType } : {}),
    chars: content.length,
    uri: entry.uri,
  });

  Logger.debug(
    `Content externalized: ${params.name} (${content.length} chars) → ${entry.uri}`
  );

  return {
    entry,
    preview: buildTextPreview(content),
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
  if (detailed.code === ErrorCode.UNKNOWN) {
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

function parseToolArgs<Schema extends z.ZodType>(
  schema: Schema,
  args: unknown
): z.infer<Schema> {
  const candidate = args === undefined ? {} : args;
  const parsed = schema.safeParse(candidate);
  if (parsed.success) {
    return parsed.data;
  }

  throw new McpError(
    ErrorCode.INVALID_INPUT,
    `Invalid tool arguments:\n${z.prettifyError(parsed.error)}`
  );
}

export function withValidatedArgs<Args, Result>(
  schema: z.ZodType<Args>,
  handler: (args: Args, ctx: ToolContext) => Promise<ToolResult<Result>>
): (
  args: unknown,
  ctx: ToolContext | ServerContext
) => Promise<ToolResult<Result>> {
  return async (args, ctx) => {
    try {
      const normalizedArgs = parseToolArgs(schema, args);
      return await handler(normalizedArgs, toToolContext(ctx));
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.INVALID_INPUT) {
        return buildToolErrorResponse(error, ErrorCode.INVALID_INPUT);
      }
      throw error;
    }
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
    return maybeStripOutputSchema(normalizedTool);
  }

  const existingIcons = (normalizedTool as { icons?: Icon[] }).icons;
  if (existingIcons && existingIcons.length > 0) {
    return maybeStripOutputSchema(normalizedTool);
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
  return maybeStripOutputSchema(withIcons);
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

/**
 * Returns `pathValue` if non-empty; otherwise resolves to the single allowed
 * directory from module-level state managed by `RootsManager`. Throws when the
 * path is ambiguous (multiple roots) or when no roots are configured.
 *
 * NOTE: Depends on `getAllowedDirectories()` which reads module-level state
 * updated by `RootsManager`. Ensure the server is initialized before calling.
 * See `src/server/roots-manager.ts` for the update lifecycle.
 */
export function resolvePathOrRoot(pathValue: string | undefined): string {
  if (pathValue && pathValue.trim().length > 0) return pathValue;
  const roots = getAllowedDirectories();
  if (roots.length === 0) {
    throw new McpError(
      ErrorCode.ACCESS_DENIED,
      'No roots configured. Use roots tool, --allow-cwd, or MCP Roots protocol.'
    );
  }
  if (roots.length > 1) {
    throw new McpError(
      ErrorCode.INVALID_INPUT,
      'Multiple roots configured. Provide an explicit path.'
    );
  }
  const root = roots[0];
  if (!root) {
    throw new McpError(
      ErrorCode.ACCESS_DENIED,
      'Workspace root is unexpectedly undefined'
    );
  }
  return root;
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
