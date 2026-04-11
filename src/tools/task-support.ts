import {
  type CallToolResult,
  type CreateTaskResult,
  type CreateTaskServerContext,
  type GetTaskResult,
  isTerminal,
  type McpServer,
  RELATED_TASK_META_KEY,
  type RequestTaskStore,
  type Result,
  type StandardSchemaWithJSON,
  type Task,
  type TaskServerContext,
  type TaskStatusNotificationParams,
  type ToolTaskHandler,
} from '@modelcontextprotocol/server';

import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';
import { format } from 'node:util';

import {
  DEFAULT_TASK_TTL_MS,
  MAX_CONCURRENT_TASKS,
  MAX_TASK_TTL_MS,
  TASK_CANCEL_POLL_MS,
  TASK_POLL_INTERVAL_MS,
} from '../lib/constants.js';
import { ErrorCode, McpError } from '../lib/errors.js';
import { Logger } from '../lib/logger.js';
import { isRecord } from '../lib/utils.js';

import {
  buildToolErrorResponse,
  type IconInfo,
  maybeStripStructuredContentFromResult,
  resolveToolTaskSupportLevel,
  type ToolContext,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResult,
  toToolContext,
  withDefaultIcons,
  withValidatedArgs,
  wrapToolHandler,
} from './shared.js';

interface TaskContext {
  taskId: string;
  toolName?: string | undefined;
  startTime: number;
}

const taskContext = new AsyncLocalStorage<TaskContext>();

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

function hasTaskToolCapability(server: McpServer): boolean {
  try {
    const capabilities = server.server.getCapabilities();
    return capabilities.tasks?.requests?.tools?.call !== undefined;
  } catch {
    return false;
  }
}

type TaskToolContext = ToolContext & {
  taskId?: string;
  taskStore?: RequestTaskStore;
  taskRequestedTtl?: number;
};

type ToolSchema = StandardSchemaWithJSON | undefined;

type ToolArgs<Args extends ToolSchema> = Args extends StandardSchemaWithJSON
  ? StandardSchemaWithJSON.InferOutput<Args>
  : undefined;

const TASK_STATUS_NOTIFICATION_METHOD = 'notifications/tasks/status';
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
  return task as GetTaskResult;
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

type TaskStatusNotificationSender = (notification: {
  method: typeof TASK_STATUS_NOTIFICATION_METHOD;
  params: TaskStatusNotificationParams;
}) => Promise<void>;

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
  if (task.pollInterval !== undefined) params.pollInterval = task.pollInterval;
  if (task.statusMessage !== undefined)
    params.statusMessage = task.statusMessage;
  return params;
}

async function notifyTaskCreatedIfPossible(
  ctx: TaskToolContext,
  taskId: string,
  toolName?: string
): Promise<void> {
  const { sendNotification } = ctx as { sendNotification?: unknown };
  if (typeof sendNotification !== 'function') return;
  const notify = sendNotification as (notification: {
    method: typeof TASK_CREATED_NOTIFICATION_METHOD;
    params: {
      _meta: Record<typeof RELATED_TASK_META_KEY, { taskId: string }>;
    };
  }) => Promise<void>;

  try {
    await notify({
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
  const { sendNotification } = ctx as { sendNotification?: unknown };
  if (typeof sendNotification !== 'function') return;
  const notify = sendNotification as TaskStatusNotificationSender;
  try {
    const task = await taskStore.getTask(taskId);
    const normalized = await projectCancelledTaskStatus(
      taskStore,
      toGetTaskResult(task)
    );
    await notify({
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
  delete stripped['structuredContent'];
  return stripped as T;
}

function isTerminalTaskStatus(status: string): boolean {
  return isTerminal(status as GetTaskResult['status']);
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
    previous.catch(() => {}).then(() => next)
  );
  await previous.catch(() => {});
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
    return typeof status === 'string' && isTerminalTaskStatus(status);
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
    if (!isTerminalTaskStatus(task.status)) {
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

  const start = performance.now();
  let taskStatuses: TaskResultStatuses;
  let result: Result;

  try {
    const rawResult = await taskContext.run(
      { taskId, toolName, startTime: start },
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

    const { sendNotification } = ctx as { sendNotification?: unknown };
    if (typeof sendNotification === 'function') {
      try {
        await (sendNotification as TaskStatusNotificationSender)({
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
function tryRegisterToolTask<Args extends ToolSchema>(
  server: McpServer,
  toolName: string,
  toolDef: object,
  taskHandler: ToolTaskHandler<Args>,
  iconInfo: IconInfo | undefined
): boolean {
  if (!hasTaskToolCapability(server)) return false;

  const def = toolDef as Record<string, unknown>;
  const existingExecution =
    (def.execution as Record<string, unknown> | undefined) ?? {};
  const taskSupport = resolveToolTaskSupportLevel(
    def.taskSupport,
    existingExecution.taskSupport
  );

  if (!taskSupport || taskSupport === 'forbidden') return false;

  server.experimental.tasks.registerToolTask(
    toolName,
    withDefaultIcons(
      { ...toolDef, execution: { ...existingExecution, taskSupport } },
      iconInfo
    ) as never,
    taskHandler as never
  );
  return true;
}

export function registerToolTaskIfAvailable<Args extends ToolSchema, Result>(
  server: McpServer,
  toolName: string,
  toolDef: object,
  run: (
    args: ToolArgs<Args>,
    ctx: TaskToolContext
  ) => Promise<ToolResult<Result>>,
  iconInfo: IconInfo | undefined,
  guard?: () => boolean
): boolean {
  const taskOptions = {
    ...(guard ? { guard } : {}),
    toolName,
  };
  return tryRegisterToolTask(
    server,
    toolName,
    toolDef,
    createToolTaskHandler(run as never, taskOptions) as ToolTaskHandler<Args>,
    iconInfo
  );
}

export function registerStandardTool<
  Args,
  Result extends Record<string, unknown>,
>(
  server: McpServer,
  toolDef: ToolContract,
  handler: (args: Args, ctx: ToolContext) => Promise<ToolResult<Result>>,
  options: ToolRegistrationOptions = {},
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
    toolDef.inputSchema as never,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      toolDef.name,
      toolDef,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  ) {
    return;
  }

  server.registerTool(
    toolDef.name,
    withDefaultIcons({ ...toolDef }, options.iconInfo),
    validatedHandler
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
      _meta: {
        'io.modelcontextprotocol/model-immediate-response': `${toolLabel} task created — poll tasks/get for progress.`,
      },
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
