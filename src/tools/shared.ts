import * as path from 'node:path';
import { channel } from 'node:diagnostics_channel';

import type {
  ContentBlock,
  Icon,
  ProgressNotificationParams,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { parseTrueEnvFlag } from '../lib/constants.js';
import {
  createDetailedError,
  ErrorCode,
  formatDetailedError,
  getSuggestion,
  McpError,
} from '../lib/errors.js';
import { createTimedAbortSignal } from '../lib/fs-helpers.js';
import { withToolDiagnostics } from '../lib/observability.js';
import { getAllowedDirectories } from '../lib/paths.js';
import type { ResourceStore } from '../lib/resource-store.js';

import type { FileInfo } from '../config.js';

export { type ToolContract } from './contract.js';

const MAX_INLINE_CONTENT_CHARS =
  parseInt(process.env['FS_CONTEXT_MAX_INLINE_CHARS'] ?? '', 10) || 20_000;
const MAX_INLINE_PREVIEW_CHARS = 4_000;
const PROGRESS_RATE_LIMIT_MS = 50;

interface ContextDiagnosticsEvent {
  phase: 'externalize_text';
  name: string;
  mimeType?: string;
  chars: number;
  uri: string;
}

const CONTEXT_DIAGNOSTICS_CHANNEL = channel('filesystem-mcp:context');

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

type TaskSupportLevel = 'optional' | 'required' | 'forbidden';

function isTaskSupportLevel(value: unknown): value is TaskSupportLevel {
  return value === 'optional' || value === 'required' || value === 'forbidden';
}

function normalizeToolExecution<T extends object>(tool: T): T {
  const candidate = tool as Record<string, unknown>;
  const topLevelTaskSupport = candidate['taskSupport'];
  const existingExecution =
    candidate['execution'] && typeof candidate['execution'] === 'object'
      ? (candidate['execution'] as Record<string, unknown>)
      : undefined;
  const executionTaskSupport = existingExecution?.['taskSupport'];
  const resolvedTaskSupport = isTaskSupportLevel(topLevelTaskSupport)
    ? topLevelTaskSupport
    : isTaskSupportLevel(executionTaskSupport)
      ? executionTaskSupport
      : undefined;

  if (resolvedTaskSupport === undefined && topLevelTaskSupport === undefined) {
    return tool;
  }

  const normalized = { ...candidate };
  delete normalized['taskSupport'];

  if (resolvedTaskSupport !== undefined || existingExecution !== undefined) {
    normalized['execution'] = {
      ...(existingExecution ?? {}),
      ...(resolvedTaskSupport !== undefined
        ? { taskSupport: resolvedTaskSupport }
        : {}),
    };
  }

  return normalized as T;
}

function shouldStripStructuredOutput(): boolean {
  return parseTrueEnvFlag(process.env['FS_CONTEXT_STRIP_STRUCTURED']);
}

export function maybeStripStructuredContentFromResult<T extends object>(
  result: T
): T {
  if (!shouldStripStructuredOutput()) return result;
  if (!Object.hasOwn(result, 'structuredContent')) return result;

  const stripped = Object.fromEntries(
    Object.entries(result as Record<string, unknown>).filter(
      ([key]) => key !== 'structuredContent'
    )
  );
  return stripped as T;
}

function maybeStripOutputSchema<T extends object>(tool: T): T {
  if (!shouldStripStructuredOutput()) return tool;
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
  if (detailed.code === ErrorCode.E_UNKNOWN) {
    detailed.code = defaultCode;
    detailed.suggestion = getSuggestion(defaultCode);
  }
  return detailed;
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
  errorCode?: string;
}

export type ToolResult<T> = ToolResponse<T> | ToolErrorResponse;

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
    ErrorCode.E_INVALID_INPUT,
    `Invalid tool arguments: ${parsed.error.message}`,
    undefined,
    { errors: z.treeifyError(parsed.error) }
  );
}

export function withValidatedArgs<Args, Result>(
  schema: z.ZodType<Args>,
  handler: (args: Args, extra: ToolExtra) => Promise<ToolResult<Result>>
): (args: unknown, extra: ToolExtra) => Promise<ToolResult<Result>> {
  return async (args, extra) => {
    const normalizedArgs = parseToolArgs(schema, args);
    return handler(normalizedArgs, extra);
  };
}

type ProgressToken = string | number;

export interface ToolExtra {
  signal?: AbortSignal;
  _meta?: {
    progressToken?: ProgressToken | undefined;
  };
  sendNotification?: (notification: {
    method: 'notifications/progress';
    params: ProgressNotificationParams;
  }) => Promise<void>;
}

function canSendProgress(extra: ToolExtra): extra is ToolExtra & {
  _meta: { progressToken: ProgressToken };
  sendNotification: NonNullable<ToolExtra['sendNotification']>;
} {
  return (
    extra._meta?.progressToken !== undefined &&
    extra.sendNotification !== undefined
  );
}

function canReportProgress(extra: ToolExtra): boolean {
  const taskExtra = extra as Record<string, unknown>;
  const hasTask =
    taskExtra.taskId !== undefined && taskExtra.taskStore !== undefined;
  return canSendProgress(extra) || hasTask;
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
    return maybeStripOutputSchema(normalizedTool) as T & { icons?: Icon[] };
  }

  const existingIcons = (normalizedTool as { icons?: Icon[] }).icons;
  if (existingIcons && existingIcons.length > 0) {
    return maybeStripOutputSchema(normalizedTool) as T & { icons?: Icon[] };
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
  return maybeStripOutputSchema(withIcons) as T & { icons?: Icon[] };
}

export interface ToolRegistrationOptions {
  resourceStore?: ResourceStore;
  isInitialized?: () => boolean;
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

const NOT_INITIALIZED_ERROR = new McpError(
  ErrorCode.E_INVALID_INPUT,
  'Client not initialized; wait for notifications/initialized'
);

async function withToolErrorHandling<T>(
  run: () => Promise<ToolResponse<T>>,
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
  extra: ToolExtra;
  run: (
    signal: AbortSignal | undefined
  ) => ToolResponse<T> | Promise<ToolResponse<T>>;
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
    return { signal: extraSignal, cleanup: () => {} };
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
  return withToolDiagnostics(
    options.toolName,
    () =>
      withToolErrorHandling(async () => {
        const { signal, cleanup } = getToolSignal(
          options.extra.signal,
          options.timedSignal
        );
        try {
          return await options.run(signal);
        } finally {
          cleanup();
        }
      }, options.onError),
    options.context
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

function buildNotInitializedResult<T>(): ToolResult<T> {
  return buildToolErrorResponse(
    NOT_INITIALIZED_ERROR,
    ErrorCode.E_INVALID_INPUT
  );
}

async function reportProgress(
  extra: ToolExtra,
  progress: { current: number; total?: number; message?: string }
): Promise<void> {
  await updateTaskStoreProgress(extra, progress);
  await sendMcpProgressNotification(extra, progress);
}

function formatTaskStatusMessage(progress: {
  current: number;
  total?: number;
  message?: string;
}): string {
  if (progress.total !== undefined) {
    return progress.message
      ? `${progress.message} (${progress.current}/${progress.total})`
      : `${progress.current}/${progress.total}`;
  }
  return progress.message ?? `${progress.current}`;
}

async function updateTaskStoreProgress(
  extra: ToolExtra,
  progress: { current: number; total?: number; message?: string }
): Promise<void> {
  const taskExtra = extra as Record<string, unknown>;
  if (
    typeof taskExtra.taskId === 'string' &&
    taskExtra.taskStore !== undefined &&
    taskExtra.taskStore !== null
  ) {
    const store = taskExtra.taskStore as Record<string, unknown>;
    if (typeof store.updateTaskStatus === 'function') {
      try {
        await (
          store.updateTaskStatus as (
            taskId: string,
            status: string,
            message?: string
          ) => Promise<void>
        )(taskExtra.taskId, 'working', formatTaskStatusMessage(progress));
      } catch (error) {
        console.error('Failed to update task status message:', error);
      }
    }
  }
}

async function sendMcpProgressNotification(
  extra: ToolExtra,
  progress: { current: number; total?: number; message?: string }
): Promise<void> {
  if (canSendProgress(extra)) {
    try {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken: extra._meta.progressToken,
          progress: progress.current,
          ...(progress.total !== undefined ? { total: progress.total } : {}),
          ...(progress.message !== undefined
            ? { message: progress.message }
            : {}),
        },
      });
    } catch (error) {
      console.error('Failed to send progress notification:', error);
    }
  }
}

export function createProgressReporter(
  extra: ToolExtra
): (progress: { total?: number; current: number; message?: string }) => void {
  if (!canReportProgress(extra)) {
    return () => {};
  }
  // State for monotonic enforcement and rate-limiting.
  let lastProgress = -1;
  let lastSentMs = 0;
  return (progress) => {
    const { current, total, message } = progress;
    // Enforce monotonic progress to prevent client confusion. Client behavior on
    // out-of-order progress is undefined in the MCP spec.
    if (current <= lastProgress) return;
    // Terminal notifications always bypass the rate limit so clients reliably
    // receive the final state even when updates arrive in quick succession.
    const isTerminal = total !== undefined && current >= total;
    const now = Date.now();
    if (!isTerminal && now - lastSentMs < PROGRESS_RATE_LIMIT_MS) return;
    lastProgress = current;
    lastSentMs = now;
    void reportProgress(extra, {
      current,
      ...(total !== undefined ? { total } : {}),
      ...(message !== undefined ? { message } : {}),
    });
  };
}

export function notifyProgress(
  extra: ToolExtra,
  progress: { current: number; total?: number; message?: string }
): void {
  if (!canReportProgress(extra)) return;
  void reportProgress(extra, progress);
}

interface ToolProgressSession {
  update: (progress: {
    current: number;
    total?: number;
    message: string;
  }) => void;
  increment: (messageForCurrent: (current: number) => string) => void;
  complete: (message: string, minimumCurrent?: number) => void;
  fail: (message: string, minimumCurrent?: number) => void;
  getCurrent: () => number;
}

interface BatchProgressCallbacks {
  progress: ToolProgressSession;
  onItemComplete: () => void;
}

export function createToolProgressSession(
  extra: ToolExtra,
  startMessage: string,
  initialTotal?: number
): ToolProgressSession {
  notifyProgress(extra, {
    current: 0,
    ...(initialTotal !== undefined ? { total: initialTotal } : {}),
    message: startMessage,
  });

  let cursor = 0;
  const baseReporter = createProgressReporter(extra);

  const setCursor = (value: number): number => {
    if (value > cursor) cursor = value;
    return cursor;
  };

  const finishProgress = (message?: string, minimumCurrent?: number): void => {
    const finalCurrent = Math.max(cursor + 1, minimumCurrent ?? 1, 1);
    notifyProgress(extra, {
      current: finalCurrent,
      total: finalCurrent,
      ...(message !== undefined ? { message } : {}),
    });
    cursor = finalCurrent;
  };

  return {
    update: ({ current, total, message }) => {
      const normalized = setCursor(current);
      baseReporter({
        current: normalized,
        ...(total !== undefined ? { total } : {}),
        message,
      });
    },
    increment: (messageForCurrent) => {
      const next = setCursor(cursor + 1);
      baseReporter({
        current: next,
        message: messageForCurrent(next),
      });
    },
    complete: finishProgress,
    fail: finishProgress,
    getCurrent: () => cursor,
  };
}

export function createBatchProgressCallbacks(
  extra: ToolExtra,
  params: {
    toolLabel: string;
    context: string;
    totalItems: number;
    itemVerb: string;
  }
): BatchProgressCallbacks {
  const progress = createToolProgressSession(
    extra,
    `${params.toolLabel}: ${params.context}`,
    params.totalItems
  );

  let itemsDone = 0;
  const onItemComplete = (): void => {
    itemsDone++;
    progress.update({
      current: itemsDone,
      total: params.totalItems,
      message: `${params.toolLabel}: ${params.context} [${itemsDone}/${params.totalItems} ${params.itemVerb}]`,
    });
  };

  return { progress, onItemComplete };
}

export function resolveFinalProgressCurrent(
  progress: ToolProgressSession,
  ...candidates: number[]
): number {
  let finalCurrent = progress.getCurrent() + 1;
  for (const candidate of candidates) {
    if (candidate > finalCurrent) {
      finalCurrent = candidate;
    }
  }
  return finalCurrent;
}

async function withProgress<T>(
  message: string,
  extra: ToolExtra,
  run: () => Promise<T>,
  getCompletionMessage?: (result: T) => string | undefined
): Promise<T> {
  if (!canReportProgress(extra)) {
    return run();
  }

  const total = 1;
  // Emit the start notification only when a progressToken is present; for
  // task-only mode the task status is already 'working' — a zero-progress
  // notification would add unnecessary overhead without client value.
  if (canSendProgress(extra)) {
    await reportProgress(extra, { current: 0, total, message });
  }

  try {
    const result = await run();
    const endMessage = getCompletionMessage?.(result) ?? message;
    await reportProgress(extra, {
      current: total,
      total,
      message: endMessage,
    });
    return result;
  } catch (error) {
    void reportProgress(extra, {
      current: total,
      total,
      message: `${message} • failed`,
    });
    throw error;
  }
}

export function wrapToolHandler<Args, Result>(
  handler: (args: Args, extra: ToolExtra) => Promise<ToolResult<Result>>,
  options: {
    guard?: (() => boolean) | undefined;
    progressMessage?: (args: Args) => string;
    completionMessage?: (
      args: Args,
      result: ToolResult<Result>
    ) => string | undefined;
  }
): (args: Args, extra?: ToolExtra) => Promise<ToolResult<Result>> {
  return async (args: Args, extra?: ToolExtra) => {
    const resolvedExtra = extra ?? {};
    if (options.guard && !options.guard()) {
      return maybeStripStructuredContentFromResult(buildNotInitializedResult());
    }

    if (options.progressMessage) {
      const message = options.progressMessage(args);
      const { completionMessage } = options;
      const completionFn = completionMessage
        ? (result: ToolResult<Result>) => completionMessage(args, result)
        : undefined;
      const result = await withProgress(
        message,
        resolvedExtra,
        () => handler(args, resolvedExtra),
        completionFn
      );
      return maybeStripStructuredContentFromResult(result);
    }

    const result = await handler(args, resolvedExtra);
    return maybeStripStructuredContentFromResult(result);
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
      ErrorCode.E_ACCESS_DENIED,
      'No workspace roots configured. Use the roots tool to check, or configure roots via the MCP Roots protocol (or start with --allow-cwd / CLI directories).'
    );
  }
  if (roots.length > 1) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Multiple workspace roots configured. Provide an explicit path to disambiguate.'
    );
  }
  const root = roots[0];
  if (!root) {
    throw new McpError(
      ErrorCode.E_ACCESS_DENIED,
      'Workspace root is unexpectedly undefined'
    );
  }
  return root;
}

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
}

export function decodeOffsetCursor(cursor: string): number {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf-8')
    );
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { offset?: unknown }).offset === 'number'
    ) {
      const { offset } = parsed as { offset: number };
      if (Number.isInteger(offset) && offset >= 0) return offset;
    }
  } catch {
    // fall through to throw
  }
  throw new McpError(
    ErrorCode.E_INVALID_INPUT,
    `Invalid cursor: the cursor value is malformed or corrupted. Request the first page without a cursor.`
  );
}

export function buildBatchPathContext(
  paths: readonly string[],
  unitLabel = 'paths'
): string {
  const normalizedLabel =
    paths.length === 1 ? unitLabel.replace(/s$/i, '') : unitLabel;
  const first = path.basename(paths[0] ?? '');
  const extraPaths =
    paths.length > 1
      ? `, ${path.basename(paths[1] ?? '')}${paths.length > 2 ? '…' : ''}`
      : '';
  return `${paths.length} ${normalizedLabel} [${first}${extraPaths}]`;
}

export function buildBatchCompletionSuffix(
  summary: { total?: number; failed?: number; succeeded?: number } | undefined,
  successWord: string,
  singularWord?: string
): string {
  const total = summary?.total ?? 0;
  const failed = summary?.failed ?? 0;
  const succeeded = summary?.succeeded ?? 0;
  if (failed) {
    return `${succeeded}/${total} ${successWord}, ${failed} failed`;
  }
  const word = total === 1 && singularWord ? singularWord : successWord;
  return `${total} ${word}`;
}
