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
  type ServerContext,
  type StandardSchemaWithJSON,
  type Task,
  type TaskServerContext,
  type TaskStatusNotification,
  type TaskStatusNotificationParams,
  type ToolTaskHandler,
} from '@modelcontextprotocol/server';

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
  completeProgressSession,
  createBatchProgressCallbacks,
  ProgressSession,
  progressSessionFromContext,
  resolveFinalProgressCurrent,
  runWithProgressSession,
} from './progress-sinks.js';
import {
  buildToolErrorResponse,
  type IconInfo,
  type TaskToolContext,
  type ToolContext,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResult,
  toToolContext,
  withDefaultIcons,
} from './shared.js';

export {
  completeProgressSession,
  createBatchProgressCallbacks,
  ProgressSession,
  progressSessionFromContext,
  resolveFinalProgressCurrent,
  runWithProgressSession,
};

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
      const label = options.progressMessage(args);
      const progress = progressSessionFromContext(resolvedExtra, { label });
      try {
        const result = await handler(args, resolvedExtra);
        const suffix = options.completionMessage?.(args, result);
        progress.complete(suffix ? `${label} • ${suffix}` : label);
        return maybeStripStructuredContentFromResult(result);
      } catch (error) {
        progress.fail(error, `${label} • ${classifyError(error)}`);
        throw error;
      }
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
    const rawResult = await run(args, taskExtra);

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
  const validatedHandler = wrappedHandler;

  if (
    registerToolTaskIfAvailable(
      server,
      toolDef.name,
      toolDef,
      validatedHandler as never,
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
    let task: Awaited<ReturnType<typeof taskStore.createTask>>;
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
