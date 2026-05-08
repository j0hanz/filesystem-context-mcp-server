import {
  type CallToolResult,
  type CreateTaskResult,
  type CreateTaskServerContext,
  type GetTaskResult,
  isTerminal,
  type McpServer,
  type ProgressNotification,
  type ProgressToken,
  RELATED_TASK_META_KEY,
  type RequestTaskStore,
  type Result,
  type ServerContext,
  type StandardSchemaWithJSON,
  type Task,
  type TaskServerContext,
  type TaskStatusNotification,
  type TaskStatusNotificationParams,
  type ToolTaskHandler,
} from '@modelcontextprotocol/server';

import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';
import { format } from 'node:util';

import type { ZodType } from 'zod/v4';

import {
  DEFAULT_TASK_TTL_MS,
  MAX_CONCURRENT_TASKS,
  MAX_TASK_TTL_MS,
  parseTrueEnvFlag,
  TASK_CANCEL_POLL_MS,
  TASK_POLL_INTERVAL_MS,
} from '../lib/constants.js';
import { classifyError, ErrorCode, McpError } from '../lib/errors.js';
import { Logger } from '../lib/logger.js';
import { assignDefined, isRecord } from '../lib/utils.js';
import { toToolJsonSchema } from '../schemas/json-schema.js';

import {
  buildToolErrorResponse,
  type HandlerContext,
  type IconInfo,
  type TaskToolContext,
  type ToolContext,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResult,
  toToolContext,
  withDefaultIcons,
  withValidatedArgs,
} from './shared.js';

// === Section A: Task Support Metadata ===
type TaskSupportLevel = 'optional' | 'required' | 'forbidden';

function isTaskSupportLevel(value: unknown): value is TaskSupportLevel {
  return value === 'optional' || value === 'required' || value === 'forbidden';
}

function resolveToolTaskSupportLevel(
  topLevelTaskSupport: unknown,
  executionTaskSupport: unknown
): TaskSupportLevel | undefined {
  if (isTaskSupportLevel(topLevelTaskSupport)) {
    return topLevelTaskSupport;
  }

  if (isTaskSupportLevel(executionTaskSupport)) {
    return executionTaskSupport;
  }

  return undefined;
}

function shouldStripStructuredOutput(): boolean {
  return parseTrueEnvFlag(process.env.FS_CONTEXT_STRIP_STRUCTURED);
}

// === Section B: Stripping Helpers (also used by Progress Handlers) ===
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

// === Section C: Progress Infrastructure ===
const PROGRESS_RATE_LIMIT_MS = 50;

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

function isBenignTaskStatusUpdateError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Task .*not found|terminal status/iu.test(error.message)
  );
}

async function updateTaskStoreProgress(
  ctx: ToolContext,
  progress: { current: number; total?: number; message?: string }
): Promise<void> {
  if (!isTaskToolContext(ctx)) return;
  try {
    await ctx.taskStore.updateTaskStatus(
      ctx.taskId,
      'working',
      formatTaskStatusMessage(progress)
    );
  } catch (error) {
    if (isBenignTaskStatusUpdateError(error)) return;
    Logger.error('Failed to update task status message:', error);
  }
}

async function sendMcpProgressNotification(
  ctx: ToolContext,
  progress: { current: number; total?: number; message?: string }
): Promise<void> {
  if (canSendProgress(ctx)) {
    try {
      await ctx.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken: ctx._meta.progressToken,
          progress: progress.current,
          ...(progress.total !== undefined ? { total: progress.total } : {}),
          ...(progress.message !== undefined
            ? { message: progress.message }
            : {}),
        },
      } satisfies ProgressNotification);
    } catch (error) {
      Logger.error('Failed to send progress notification:', error);
    }
  }
}

async function reportProgress(
  ctx: ToolContext,
  progress: { current: number; total?: number; message?: string }
): Promise<void> {
  await updateTaskStoreProgress(ctx, progress);
  await sendMcpProgressNotification(ctx, progress);
}

function createProgressReporter(
  ctx: ToolContext
): (progress: { total?: number; current: number; message?: string }) => void {
  if (!canReportProgress(ctx)) {
    return () => undefined;
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
    void reportProgress(ctx, {
      current,
      ...(total !== undefined ? { total } : {}),
      ...(message !== undefined ? { message } : {}),
    });
  };
}

/**
 * Converts a ToolContext to an onProgress callback, or returns undefined if progress
 * cannot be reported. Used internally to adapt ToolContext-based reporting to
 * HandlerContext-based callbacks.
 */
export function toolContextToOnProgress(
  ctx: ToolContext
):
  | ((params: { current: number; total?: number; message?: string }) => void)
  | undefined {
  if (!canReportProgress(ctx)) {
    return undefined;
  }
  return createProgressReporter(ctx);
}

export interface ToolProgressSession {
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

/**
 * Private helper that builds a progress session from an onProgress callback.
 * This is the core session logic, decoupled from ToolContext.
 */
function buildProgressSessionFromOnProgress(
  onProgress:
    | ((params: { current: number; total?: number; message?: string }) => void)
    | undefined,
  startMessage: string,
  initialTotal?: number
): ToolProgressSession {
  // Fire initial progress notification if callback exists
  if (onProgress) {
    onProgress({
      current: 0,
      ...(initialTotal !== undefined ? { total: initialTotal } : {}),
      message: startMessage,
    });
  }

  let cursor = 0;

  const setCursor = (value: number): number => {
    if (value > cursor) cursor = value;
    return cursor;
  };

  const finishProgress = (message?: string, minimumCurrent?: number): void => {
    const finalCurrent = Math.max(cursor + 1, minimumCurrent ?? 1, 1);
    if (onProgress) {
      onProgress({
        current: finalCurrent,
        total: finalCurrent,
        ...(message !== undefined ? { message } : {}),
      });
    }
    cursor = finalCurrent;
  };

  return {
    update: ({ current, total, message }) => {
      const normalized = setCursor(current);
      if (onProgress) {
        onProgress({
          current: normalized,
          ...(total !== undefined ? { total } : {}),
          message,
        });
      }
    },
    increment: (messageForCurrent) => {
      const next = setCursor(cursor + 1);
      if (onProgress) {
        onProgress({
          current: next,
          message: messageForCurrent(next),
        });
      }
    },
    complete: finishProgress,
    fail: finishProgress,
    getCurrent: () => cursor,
  };
}

interface BatchProgressCallbacks {
  progress: ToolProgressSession;
  onItemComplete: () => void;
}

export function createBatchProgressCallbacks(
  ctx: HandlerContext,
  params: {
    toolLabel: string;
    context: string;
    totalItems: number;
    itemVerb: string;
  }
): BatchProgressCallbacks {
  const progress = buildProgressSessionFromOnProgress(
    ctx.onProgress,
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

export async function completeProgressSession<T>(
  progress: ToolProgressSession,
  label: string,
  body: () => Promise<{ value: T; suffix: string; finalCurrent?: number }>
): Promise<T> {
  try {
    const { value, suffix, finalCurrent } = await body();
    progress.complete(`${label} • ${suffix}`, finalCurrent);
    return value;
  } catch (error) {
    progress.fail(`${label} • ${classifyError(error)}`);
    throw error;
  }
}

export async function runWithProgressSession<T>(
  ctx: HandlerContext,
  label: string,
  body: (
    progress: ToolProgressSession
  ) => Promise<{ value: T; suffix: string; finalCurrent?: number }>,
  initialTotal?: number
): Promise<T> {
  const progress = buildProgressSessionFromOnProgress(
    ctx.onProgress,
    label,
    initialTotal
  );
  return completeProgressSession(progress, label, () => body(progress));
}

async function withProgress<T>(
  message: string,
  ctx: ToolContext,
  run: () => Promise<T>,
  getCompletionMessage?: (result: T) => string | undefined
): Promise<T> {
  if (!canReportProgress(ctx)) {
    return run();
  }

  const total = 1;
  if (canSendProgress(ctx)) {
    await reportProgress(ctx, { current: 0, total, message });
  }

  try {
    const result = await run();
    const endMessage = getCompletionMessage?.(result) ?? message;
    await reportProgress(ctx, {
      current: total,
      total,
      message: endMessage,
    });
    return result;
  } catch (error) {
    void reportProgress(ctx, {
      current: total,
      total,
      message: `${message} • ${classifyError(error)}`,
    });
    throw error;
  }
}

function wrapToolHandler<Args, Result>(
  handler: (args: Args, ctx: ToolContext) => Promise<ToolResult<Result>>,
  options: {
    guard?: (() => boolean) | undefined;
    progressMessage?: (args: Args) => string;
    completionMessage?: (
      args: Args,
      result: ToolResult<Result>
    ) => string | undefined;
  }
): (
  args: Args,
  ctx?: ToolContext | ServerContext
) => Promise<ToolResult<Result>> {
  return async (args: Args, ctx?: ToolContext | ServerContext) => {
    const resolvedExtra = toToolContext(ctx);
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

function buildNotInitializedResult<T>(): ToolResult<T> {
  return buildToolErrorResponse(NOT_INITIALIZED_ERROR, ErrorCode.INVALID_INPUT);
}

const NOT_INITIALIZED_ERROR = new McpError(
  ErrorCode.INVALID_INPUT,
  'Server not initialized. Roots unavailable.'
);

function canSendProgress(ctx: ToolContext): ctx is ToolContext & {
  _meta: { progressToken: ProgressToken };
  sendNotification: NonNullable<ToolContext['sendNotification']>;
} {
  return (
    ctx._meta?.progressToken !== undefined && ctx.sendNotification !== undefined
  );
}

function canReportProgress(ctx: ToolContext): boolean {
  return canSendProgress(ctx) || isTaskToolContext(ctx);
}

function isTaskToolContext(
  ctx: ToolContext
): ctx is ToolContext & { taskId: string; taskStore: RequestTaskStore } {
  const candidate = ctx as TaskToolContext;
  return (
    typeof candidate.taskId === 'string' &&
    candidate.taskId.length > 0 &&
    candidate.taskStore !== undefined
  );
}
interface TaskContext {
  taskId: string;
  toolName?: string | undefined;
  startTime: number;
  taskStore: RequestTaskStore;
  ctx: TaskToolContext;
}

const taskContext = new AsyncLocalStorage<TaskContext>();

/**
 * Report an intermediate 'working' status update for the current task.
 * No-op when called outside of a task context.
 */
export async function reportTaskStatus(statusMessage: string): Promise<void> {
  const store = taskContext.getStore();
  if (!store) return;
  const { taskId, taskStore, ctx, toolName } = store;
  try {
    await taskStore.updateTaskStatus(taskId, 'working', statusMessage);
    await notifyTaskStatusIfPossible(ctx, taskStore, taskId, toolName);
  } catch {
    // Best-effort: never fail tool execution for status updates.
  }
}

interface TaskDiagnosticsEvent {
  phase:
    | 'task_created'
    | 'task_result_stored'
    | 'task_status_notified'
    | 'task_status_notify_failed';
  taskId: string;
  status?: GetTaskResult['status'];
  toolName?: string | undefined;
  durationMs?: number;
}

const TASK_DIAGNOSTICS_CHANNEL = channel('filesystem-mcp:tasks');

function publishTaskDiagnostics(event: TaskDiagnosticsEvent): void {
  if (TASK_DIAGNOSTICS_CHANNEL.hasSubscribers) {
    TASK_DIAGNOSTICS_CHANNEL.publish(event);
  }
}

// --- Type Guards & Helpers ---

type ToolSchema = StandardSchemaWithJSON | undefined;

type ToolArgs<Args extends ToolSchema> = Args extends StandardSchemaWithJSON
  ? StandardSchemaWithJSON.InferOutput<Args>
  : undefined;

const TASK_STATUS_NOTIFICATION_METHOD: TaskStatusNotification['method'] =
  'notifications/tasks/status';
const TASK_CREATED_NOTIFICATION_METHOD = 'notifications/tasks/created';

function assertCreateTaskContext(
  value: CreateTaskServerContext | TaskServerContext
): asserts value is CreateTaskServerContext & {
  task: { store: RequestTaskStore };
} {
  if (!isRecord(value.task) || typeof value.task.store !== 'object') {
    throw new McpError(ErrorCode.INVALID_INPUT, 'Task store not configured.');
  }
}

function assertTaskRequestContext(
  value: TaskServerContext
): asserts value is TaskServerContext & {
  task: { store: RequestTaskStore; id: string };
} {
  if (
    !isRecord(value.task) ||
    typeof value.task.store !== 'object' ||
    typeof value.task.id !== 'string' ||
    value.task.id.length === 0
  ) {
    throw new McpError(ErrorCode.INVALID_INPUT, 'Task id or store missing.');
  }
}

function toTaskToolContext(
  ctx: CreateTaskServerContext | TaskServerContext
): TaskToolContext {
  return {
    ...toToolContext(ctx),
    taskStore: ctx.task.store,
    ...(typeof ctx.task.id === 'string' && ctx.task.id.length > 0
      ? { taskId: ctx.task.id }
      : {}),
    ...(ctx.task.requestedTtl !== undefined
      ? { taskRequestedTtl: ctx.task.requestedTtl }
      : {}),
  };
}

function toGetTaskResult(task: Task): GetTaskResult {
  return task;
}

function toCallToolResult(value: Result): CallToolResult {
  return value as CallToolResult;
}

function getToolResultErrorCode(result: Result): string | undefined {
  if (!isRecord(result) || result.isError !== true) return undefined;
  if (typeof result.errorCode === 'string') return result.errorCode;
  const { content } = result as { content?: unknown[] };
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0];
  if (!isRecord(first) || first.type !== 'text') return undefined;
  const { text } = first;
  if (typeof text !== 'string') return undefined;
  const match = /^Error \[([A-Z0-9_]+)\]:/.exec(text);
  return match ? match[1] : undefined;
}

function isCancelledToolResult(result: Result): boolean {
  return getToolResultErrorCode(result) === ErrorCode.CANCELLED;
}

interface TaskResultStatuses {
  storedStatus: 'completed' | 'failed';
  reportedStatus: GetTaskResult['status'];
}

function resolveTaskResultStatuses(result: Result): TaskResultStatuses {
  if (isCancelledToolResult(result)) {
    return { storedStatus: 'failed', reportedStatus: 'cancelled' };
  }
  if (isRecord(result) && result.isError === true) {
    return { storedStatus: 'failed', reportedStatus: 'failed' };
  }
  return { storedStatus: 'completed', reportedStatus: 'completed' };
}

function attachRelatedTaskMeta(
  result: CallToolResult,
  taskId: string
): CallToolResult {
  const existingMeta = isRecord(result._meta) ? result._meta : {};
  return {
    ...result,
    _meta: {
      ...existingMeta,
      [RELATED_TASK_META_KEY]: { taskId },
    },
  };
}

async function projectCancelledTaskStatus(
  taskStore: RequestTaskStore,
  task: GetTaskResult
): Promise<GetTaskResult> {
  if (task.status !== 'failed') return task;
  try {
    const result = await taskStore.getTaskResult(task.taskId);
    if (isCancelledToolResult(result)) {
      return { ...task, status: 'cancelled' };
    }
  } catch {
    // Best effort only: task result may not be available yet.
  }
  return task;
}

function buildTaskStatusNotificationParams(
  task: GetTaskResult
): TaskStatusNotificationParams {
  const params: TaskStatusNotificationParams = {
    taskId: task.taskId,
    status: task.status,
    ttl: task.ttl,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
  };
  return assignDefined(params, {
    pollInterval: task.pollInterval,
    statusMessage: task.statusMessage,
  });
}

async function notifyTaskCreatedIfPossible(
  ctx: TaskToolContext,
  taskId: string,
  toolName?: string
): Promise<void> {
  if (!ctx.sendNotification) return;

  try {
    await ctx.sendNotification({
      method: TASK_CREATED_NOTIFICATION_METHOD,
      params: {
        _meta: {
          [RELATED_TASK_META_KEY]: {
            taskId,
          },
        },
      },
    });
  } catch {
    publishTaskDiagnostics({
      phase: 'task_status_notify_failed',
      taskId,
      ...(toolName ? { toolName } : {}),
    });
  }
}

async function notifyTaskStatusIfPossible(
  ctx: TaskToolContext,
  taskStore: RequestTaskStore,
  taskId: string,
  toolName?: string
): Promise<void> {
  if (!ctx.sendNotification) return;

  try {
    const task = await taskStore.getTask(taskId);
    const normalized = await projectCancelledTaskStatus(
      taskStore,
      toGetTaskResult(task)
    );
    await ctx.sendNotification({
      method: TASK_STATUS_NOTIFICATION_METHOD,
      params: buildTaskStatusNotificationParams(normalized),
    });
    publishTaskDiagnostics({
      phase: 'task_status_notified',
      taskId,
      status: normalized.status,
      ...(toolName ? { toolName } : {}),
    });
  } catch {
    publishTaskDiagnostics({
      phase: 'task_status_notify_failed',
      taskId,
      ...(toolName ? { toolName } : {}),
    });
    // Never fail task execution because status notifications are optional.
  }
}

function getTaskStore(ctx: TaskToolContext): RequestTaskStore {
  if (!ctx.taskStore) {
    throw new McpError(ErrorCode.INVALID_INPUT, 'Task store not configured.');
  }
  return ctx.taskStore;
}

function getTaskId(ctx: TaskToolContext): string {
  if (!ctx.taskId) {
    throw new McpError(ErrorCode.INVALID_INPUT, 'Task id missing.');
  }
  return ctx.taskId;
}

function isErrorResult(result: ToolResult<unknown>): boolean {
  return 'isError' in result && result.isError;
}

// Strips structuredContent from a tool result if present, without modifying the original object.
function withoutStructuredContent<T extends object>(result: T): T {
  if (!Object.hasOwn(result, 'structuredContent')) return result;
  const stripped = { ...(result as Record<string, unknown>) };
  delete stripped.structuredContent;
  return stripped as T;
}

const taskCreationLocks = new WeakMap<RequestTaskStore, Promise<void>>();

async function acquireTaskCreationLock(
  taskStore: RequestTaskStore
): Promise<() => void> {
  const previous = taskCreationLocks.get(taskStore) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });

  taskCreationLocks.set(
    taskStore,
    previous.catch(() => undefined).then(() => next)
  );
  await previous.catch(() => undefined);
  return () => {
    release();
  };
}

async function isTaskAlreadyTerminal(
  taskStore: RequestTaskStore,
  taskId: string
): Promise<boolean> {
  try {
    const task = await taskStore.getTask(taskId);
    if (!isRecord(task)) return false;
    const { status } = task;
    return typeof status === 'string' && isTerminal(status);
  } catch {
    return false;
  }
}

function isMissingTaskStoreError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Task .*not found|not found after cancellation/iu.test(error.message)
  );
}

async function countActiveTasks(taskStore: RequestTaskStore): Promise<number> {
  if (typeof taskStore.listTasks !== 'function') return 0;
  const listed = await taskStore.listTasks();
  const tasks = Array.isArray(listed.tasks) ? listed.tasks : [];
  let active = 0;
  for (const task of tasks) {
    if (!isRecord(task) || typeof task.status !== 'string') continue;
    if (!isTerminal(task.status)) {
      active += 1;
    }
  }
  return active;
}

function resolveRequestedTaskTtl(requestedTtl: number | undefined): number {
  if (requestedTtl === undefined) return DEFAULT_TASK_TTL_MS;
  if (!Number.isFinite(requestedTtl)) {
    throw new McpError(ErrorCode.INVALID_INPUT, 'Task TTL must be finite.');
  }

  const normalized = Math.trunc(requestedTtl);
  if (normalized <= 0) {
    throw new McpError(ErrorCode.INVALID_INPUT, 'Task TTL must be > 0.');
  }

  return Math.min(normalized, MAX_TASK_TTL_MS);
}

async function safelyStoreTaskResult(
  taskStore: RequestTaskStore,
  taskId: string,
  storedStatus: 'completed' | 'failed',
  result: Result
): Promise<void> {
  try {
    await taskStore.storeTaskResult(taskId, storedStatus, result);
  } catch (error) {
    if (isMissingTaskStoreError(error)) return;
    // If task was already cancelled/failed by another process, ignore the write error
    if (await isTaskAlreadyTerminal(taskStore, taskId)) return;
    throw error;
  }
}

async function isTaskCancelled(
  taskStore: RequestTaskStore,
  taskId: string
): Promise<boolean> {
  try {
    const task = await taskStore.getTask(taskId);
    return isRecord(task) && task.status === 'cancelled';
  } catch {
    return false;
  }
}

async function runTaskInBackground<Args extends ToolSchema>(
  run: (
    args: ToolArgs<Args>,
    ctx: TaskToolContext
  ) => Promise<ToolResult<unknown>>,
  args: ToolArgs<Args>,
  ctx: TaskToolContext,
  taskStore: RequestTaskStore,
  taskId: string,
  toolName?: string,
  cancelPollMs?: number
): Promise<void> {
  // Create a dedicated AbortController for background execution.
  // The original request signal is stale once createTask returns.
  const taskAbort = new AbortController();
  const taskExtra: TaskToolContext = { ...ctx, signal: taskAbort.signal };

  // Poll the task store for client-initiated cancellation.
  const cancelPoller = setInterval(() => {
    void isTaskCancelled(taskStore, taskId).then((cancelled) => {
      if (cancelled) taskAbort.abort(new Error('Task cancelled by client'));
    });
  }, cancelPollMs ?? TASK_CANCEL_POLL_MS);
  cancelPoller.unref();

  const start = performance.now();
  let taskStatuses: TaskResultStatuses;
  let result: Result;

  try {
    const rawResult = await taskContext.run(
      { taskId, toolName, startTime: start, taskStore, ctx: taskExtra },
      () => run(args, taskExtra)
    );

    taskStatuses = resolveTaskResultStatuses(rawResult);
    result = isErrorResult(rawResult)
      ? withoutStructuredContent(rawResult)
      : maybeStripStructuredContentFromResult(rawResult);
  } catch (error) {
    taskStatuses = { storedStatus: 'failed', reportedStatus: 'failed' };
    result = maybeStripStructuredContentFromResult(
      buildToolErrorResponse(error, ErrorCode.UNKNOWN)
    );
  } finally {
    clearInterval(cancelPoller);
  }

  const durationMs = performance.now() - start;

  try {
    await safelyStoreTaskResult(
      taskStore,
      taskId,
      taskStatuses.storedStatus,
      result
    );

    publishTaskDiagnostics({
      phase: 'task_result_stored',
      taskId,
      status: taskStatuses.reportedStatus,
      toolName,
      durationMs,
    });
    await notifyTaskStatusIfPossible(ctx, taskStore, taskId, toolName);
  } catch (innerError) {
    Logger.error(
      format('Failed to store task result for task %s:', taskId),
      innerError
    );

    const syntheticTask: GetTaskResult = {
      taskId,
      status:
        taskStatuses.reportedStatus === 'cancelled' ? 'cancelled' : 'failed',
      ttl: null,
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      statusMessage: 'Internal system error while storing result',
    };

    if (ctx.sendNotification) {
      try {
        await ctx.sendNotification({
          method: TASK_STATUS_NOTIFICATION_METHOD,
          params: buildTaskStatusNotificationParams(syntheticTask),
        });
      } catch {
        // Best effort only: transport may already be closed while a cancelled
        // task is still unwinding in the background.
      }
    }
  }
}

/**
 * Registers a tool preferring task-capable registration when available, and
 * returns `true`. Returns `false` so the caller can fall through to standard
 * `server.registerTool`.
 */
// Convert Zod schemas in a tool definition to Standard Schemas for MCP wire format.
// Uses inputSchemaJson when provided (pre-augmented schema, e.g. with oneOf).
function convertSchemasToWire(
  toolDef: Record<string, unknown>,
  inputSchemaJson?: ReturnType<typeof toToolJsonSchema>
): Record<string, unknown> {
  const result = { ...toolDef };
  result.inputSchema =
    inputSchemaJson ?? toToolJsonSchema(result.inputSchema as ZodType);
  if (result.outputSchema != null) {
    result.outputSchema = toToolJsonSchema(result.outputSchema as ZodType);
  }
  // Remove the helper field — not part of MCP wire protocol
  delete result.inputSchemaJson;
  return result;
}

function tryRegisterToolTask<Args extends ToolSchema>(
  server: McpServer,
  toolName: string,
  toolDef: object,
  taskHandler: ToolTaskHandler<Args>,
  iconInfo: IconInfo | undefined
): boolean {
  const def = toolDef as Record<string, unknown>;
  const existingExecution =
    (def.execution as Record<string, unknown> | undefined) ?? {};
  const taskSupport = resolveToolTaskSupportLevel(
    def.taskSupport,
    existingExecution.taskSupport
  );

  if (!taskSupport || taskSupport === 'forbidden') return false;

  // `as never`: the MCP SDK uses `StandardSchema` generics for tool registration,
  // but we hand it a JSON-Schema-shaped object produced by `convertSchemasToWire`.
  // The runtime shape is verified by the SDK's own validation; the cast bridges
  // the structural gap without disabling type-checking elsewhere.
  server.experimental.tasks.registerToolTask(
    toolName,
    convertSchemasToWire(
      withDefaultIcons(
        { ...toolDef, execution: { ...existingExecution, taskSupport } },
        iconInfo
      ),
      (toolDef as ToolContract).inputSchemaJson
    ) as never,
    taskHandler as never
  );
  return true;
}

function registerToolTaskIfAvailable<Args extends ToolSchema, Result>(
  server: McpServer,
  toolName: string,
  toolDef: object,
  run: (
    args: ToolArgs<Args>,
    ctx: TaskToolContext
  ) => Promise<ToolResult<Result>>,
  options: ToolRegistrationOptions
): boolean {
  if (!options.hasTaskSupport) return false;
  const taskOptions = {
    ...(options.isInitialized ? { guard: options.isInitialized } : {}),
    toolName,
  };
  return tryRegisterToolTask(
    server,
    toolName,
    toolDef,
    // `as never`: bridges the Zod-typed `run` to the SDK's structural
    // `ToolTaskHandler<Args>`; argument shape is enforced by `withValidatedArgs`.
    createToolTaskHandler(run as never, taskOptions) as ToolTaskHandler<Args>,
    options.iconInfo
  );
}

export function registerStandardTool<
  Args,
  Result extends Record<string, unknown>,
>(
  server: McpServer,
  toolDef: ToolContract,
  handler: (args: Args, ctx: ToolContext) => Promise<ToolResult<Result>>,
  options: ToolRegistrationOptions,
  wrapOptions: {
    guard?: (() => boolean) | undefined;
    progressMessage?: (args: Args) => string;
    completionMessage?: (
      args: Args,
      result: ToolResult<Result>
    ) => string | undefined;
  } = {}
): void {
  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    ...wrapOptions,
  });
  const validatedHandler = withValidatedArgs(
    // `as never`: `inputSchema` is a Zod schema but typed loosely on `ToolContract`;
    // `withValidatedArgs` will re-narrow at runtime via `safeParse`.
    toolDef.inputSchema as never,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      toolDef.name,
      toolDef,
      validatedHandler,
      options
    )
  ) {
    return;
  }

  server.registerTool(
    toolDef.name,
    // `as never`: see `tryRegisterToolTask` — same StandardSchema/JSON-Schema bridge.
    convertSchemasToWire(
      withDefaultIcons({ ...toolDef }, options.iconInfo),
      toolDef.inputSchemaJson
    ),
    validatedHandler as never
  );
}

interface TaskHandlerOptions {
  guard?: () => boolean;
  toolName?: string;
  cancelPollMs?: number;
  pollIntervalMs?: number;
}

export function createToolTaskHandler<Result>(
  run: (args: undefined, ctx: TaskToolContext) => Promise<ToolResult<Result>>,
  options?: TaskHandlerOptions
): ToolTaskHandler;
export function createToolTaskHandler<
  Args extends StandardSchemaWithJSON,
  Result,
>(
  run: (
    args: ToolArgs<Args>,
    ctx: TaskToolContext
  ) => Promise<ToolResult<Result>>,
  options?: TaskHandlerOptions
): ToolTaskHandler<Args>;
export function createToolTaskHandler<Args extends ToolSchema, Result>(
  run: (
    args: ToolArgs<Args>,
    ctx: TaskToolContext
  ) => Promise<ToolResult<Result>>,
  options?: TaskHandlerOptions
): ToolTaskHandler<Args> {
  const createTask = (async (
    ...params:
      | [ToolArgs<Args>, CreateTaskServerContext]
      | [CreateTaskServerContext]
  ): Promise<CreateTaskResult> => {
    let args!: ToolArgs<Args>;
    let serverCtx: CreateTaskServerContext;
    if (params.length === 1) {
      serverCtx = params[0];
    } else {
      [args, serverCtx] = params;
    }
    assertCreateTaskContext(serverCtx);
    const ctx = toTaskToolContext(serverCtx);

    if (options?.guard && !options.guard()) {
      throw new McpError(
        ErrorCode.INVALID_INPUT,
        'Client not initialized; wait for notifications/initialized'
      );
    }

    const taskStore = getTaskStore(ctx);
    const releaseCreationLock = await acquireTaskCreationLock(taskStore);
    let task;
    try {
      if ((await countActiveTasks(taskStore)) >= MAX_CONCURRENT_TASKS) {
        throw new McpError(
          ErrorCode.INVALID_INPUT,
          `Too many active tasks (limit: ${String(MAX_CONCURRENT_TASKS)}).`
        );
      }
      task = await taskStore.createTask({
        ttl: resolveRequestedTaskTtl(ctx.taskRequestedTtl),
        pollInterval: options?.pollIntervalMs ?? TASK_POLL_INTERVAL_MS,
      });
    } finally {
      releaseCreationLock();
    }

    const toolLabel = options?.toolName ?? 'tool';
    try {
      await taskStore.updateTaskStatus(
        task.taskId,
        'working',
        `${toolLabel}: starting`
      );
    } catch {
      // Best effort — status message is informational.
    }

    publishTaskDiagnostics({
      phase: 'task_created',
      taskId: task.taskId,
      status: task.status,
      ...(options?.toolName ? { toolName: options.toolName } : {}),
    });
    const taskExtra: TaskToolContext = {
      ...ctx,
      taskStore,
      taskId: task.taskId,
    };
    void notifyTaskCreatedIfPossible(taskExtra, task.taskId, options?.toolName);
    void notifyTaskStatusIfPossible(
      taskExtra,
      taskStore,
      task.taskId,
      options?.toolName
    );
    void runTaskInBackground(
      run,
      args,
      taskExtra,
      taskStore,
      task.taskId,
      options?.toolName,
      options?.cancelPollMs
    );
    return {
      task,
    };
  }) as ToolTaskHandler<Args>['createTask'];

  const getTask = (async (
    ...params: [ToolArgs<Args>, TaskServerContext] | [TaskServerContext]
  ): Promise<GetTaskResult> => {
    const serverCtx = params.length === 1 ? params[0] : params[1];
    assertTaskRequestContext(serverCtx);
    const ctx = toTaskToolContext(serverCtx);
    const taskStore = getTaskStore(ctx);
    const taskId = getTaskId(ctx);
    const task = await taskStore.getTask(taskId);
    return projectCancelledTaskStatus(taskStore, toGetTaskResult(task));
  }) as ToolTaskHandler<Args>['getTask'];

  const getTaskResult = (async (
    ...params: [ToolArgs<Args>, TaskServerContext] | [TaskServerContext]
  ): Promise<CallToolResult> => {
    const serverCtx = params.length === 1 ? params[0] : params[1];
    assertTaskRequestContext(serverCtx);
    const ctx = toTaskToolContext(serverCtx);
    const taskStore = getTaskStore(ctx);
    const taskId = getTaskId(ctx);
    const result = await taskStore.getTaskResult(taskId);
    return attachRelatedTaskMeta(toCallToolResult(result), taskId);
  }) as ToolTaskHandler<Args>['getTaskResult'];

  return {
    createTask,
    getTask,
    getTaskResult,
  };
}
