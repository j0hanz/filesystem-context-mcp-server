import type {
  CreateTaskRequestHandlerExtra,
  TaskRequestHandlerExtra,
  ToolTaskHandler,
} from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  AnySchema,
  SchemaOutput,
  ShapeOutput,
  ZodRawShapeCompat,
} from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { RequestTaskStore } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  type CallToolResult,
  CallToolResultSchema,
  type CreateTaskResult,
  type GetTaskResult,
  type Result,
  type TaskStatusNotificationParams,
} from '@modelcontextprotocol/sdk/types.js';

import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';
import { format } from 'node:util';

import {
  DEFAULT_TASK_TTL_MS,
  MAX_CONCURRENT_TASKS,
  MAX_TASK_TTL_MS,
} from '../lib/constants.js';
import { ErrorCode, McpError } from '../lib/errors.js';
import { Logger } from '../lib/logger.js';
import { isRecord } from '../lib/utils.js';

import {
  buildToolErrorResponse,
  type IconInfo,
  maybeStripStructuredContentFromResult,
  type ToolExtra,
  type ToolResult,
  withDefaultIcons,
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
  status?: GetTaskResult['status'] | 'completed' | 'failed';
  toolName?: string | undefined;
  durationMs?: number;
}

const TASK_DIAGNOSTICS_CHANNEL = channel('filesystem-mcp:tasks');

function publishTaskDiagnostics(event: TaskDiagnosticsEvent): void {
  if (TASK_DIAGNOSTICS_CHANNEL.hasSubscribers) {
    TASK_DIAGNOSTICS_CHANNEL.publish(event);
  }
}

type CapabilityGetter = (this: object) => unknown;

function getDynamicProperty(target: object, key: string): unknown {
  return Reflect.get(target, key) as unknown;
}

// --- Type Guards & Helpers ---

function isExperimentalTaskRegistration(
  value: unknown
): value is { registerToolTask?: (...args: unknown[]) => unknown } {
  if (!isRecord(value)) return false;
  const { registerToolTask } = value;
  return (
    registerToolTask === undefined || typeof registerToolTask === 'function'
  );
}

function getExperimentalTaskRegistration(
  server: McpServer
): { registerToolTask?: (...args: unknown[]) => unknown } | undefined {
  const experimental = getDynamicProperty(server, 'experimental');
  if (!isRecord(experimental)) return undefined;
  const { tasks } = experimental;
  if (!isExperimentalTaskRegistration(tasks)) return undefined;
  return tasks;
}

function hasTaskToolCapability(server: McpServer): boolean {
  const serverRuntime = getDynamicProperty(server, 'server');
  if (!isRecord(serverRuntime)) return true; // Assume capability if runtime structure is opaque

  const getCapabilities = getDynamicProperty(serverRuntime, 'getCapabilities');
  if (typeof getCapabilities !== 'function') return true;

  const capabilities = (getCapabilities as CapabilityGetter).call(
    serverRuntime
  );
  if (!isRecord(capabilities)) return false;
  const { tasks } = capabilities;
  return (
    isRecord(tasks) &&
    isRecord(tasks.requests) &&
    isRecord(tasks.requests.tools) &&
    isRecord(tasks.requests.tools.call)
  );
}

type TaskToolExtra = ToolExtra & {
  taskId?: string;
  taskStore?: RequestTaskStore;
  taskRequestedTtl?: number | null;
};

export type ToolSchema = ZodRawShapeCompat | AnySchema | undefined;

type ToolArgs<Args extends ToolSchema> = Args extends ZodRawShapeCompat
  ? ShapeOutput<Args>
  : Args extends AnySchema
    ? SchemaOutput<Args>
    : undefined;

const TASK_STATUS_NOTIFICATION_METHOD = 'notifications/tasks/status';
const TASK_CREATED_NOTIFICATION_METHOD = 'notifications/tasks/created';

function isRequestTaskStore(value: unknown): value is RequestTaskStore {
  return (
    isRecord(value) &&
    typeof value.createTask === 'function' &&
    typeof value.getTask === 'function' &&
    typeof value.storeTaskResult === 'function' &&
    typeof value.getTaskResult === 'function'
  );
}

function isCreateTaskExtra(
  value: unknown
): value is CreateTaskRequestHandlerExtra {
  return isRecord(value) && isRequestTaskStore(value.taskStore);
}

function isTaskExtra(value: unknown): value is TaskRequestHandlerExtra {
  return (
    isCreateTaskExtra(value) &&
    typeof value.taskId === 'string' &&
    value.taskId.length > 0
  );
}

function asCreateTaskExtra(value: unknown): CreateTaskRequestHandlerExtra {
  if (!isCreateTaskExtra(value)) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Task store not configured for task-capable tool.'
    );
  }
  return value;
}

function asTaskRequestExtra(value: unknown): TaskRequestHandlerExtra {
  if (!isTaskExtra(value)) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Task id or task store missing for task operation.'
    );
  }
  return value;
}

const TASK_STATUSES = new Set<GetTaskResult['status']>([
  'working',
  'input_required',
  'completed',
  'failed',
  'cancelled',
]);

function isTaskStatus(value: unknown): value is GetTaskResult['status'] {
  return (
    typeof value === 'string' &&
    TASK_STATUSES.has(value as GetTaskResult['status'])
  );
}

function normalizeGetTaskResult(value: unknown): GetTaskResult {
  if (!isRecord(value) || typeof value.taskId !== 'string') {
    throw new McpError(ErrorCode.E_INVALID_INPUT, 'Invalid task object.');
  }

  const status = isTaskStatus(value.status) ? value.status : undefined;
  if (!status) {
    throw new McpError(ErrorCode.E_INVALID_INPUT, 'Invalid task status.');
  }

  const createdAt =
    typeof value.createdAt === 'string'
      ? value.createdAt
      : new Date().toISOString();
  const lastUpdatedAt =
    typeof value.lastUpdatedAt === 'string' ? value.lastUpdatedAt : createdAt;
  const ttl = typeof value.ttl === 'number' ? value.ttl : null;

  const normalized: GetTaskResult = {
    taskId: value.taskId,
    status,
    ttl,
    createdAt,
    lastUpdatedAt,
  };

  if (typeof value.pollInterval === 'number') {
    normalized.pollInterval = value.pollInterval;
  }
  if (typeof value.statusMessage === 'string') {
    normalized.statusMessage = value.statusMessage;
  }
  if (isRecord(value._meta)) {
    normalized._meta = value._meta;
  }

  return normalized;
}

function normalizeCallToolResult(value: Result): CallToolResult {
  const parsed = CallToolResultSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new McpError(
    ErrorCode.E_INVALID_INPUT,
    'Stored task result is not a valid tool result.'
  );
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
  return getToolResultErrorCode(result) === ErrorCode.E_CANCELLED;
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
      'io.modelcontextprotocol/related-task': { taskId },
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
  extra: TaskToolExtra,
  taskId: string,
  toolName?: string
): Promise<void> {
  const { sendNotification } = extra as { sendNotification?: unknown };
  if (typeof sendNotification !== 'function') return;
  const notify = sendNotification as (notification: {
    method: typeof TASK_CREATED_NOTIFICATION_METHOD;
    params: {
      _meta: {
        'modelcontextprotocol.io/related-task': {
          taskId: string;
        };
      };
    };
  }) => Promise<void>;

  try {
    await notify({
      method: TASK_CREATED_NOTIFICATION_METHOD,
      params: {
        _meta: {
          'modelcontextprotocol.io/related-task': {
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
  extra: TaskToolExtra,
  taskStore: RequestTaskStore,
  taskId: string,
  toolName?: string
): Promise<void> {
  const { sendNotification } = extra as { sendNotification?: unknown };
  if (typeof sendNotification !== 'function') return;
  const notify = sendNotification as TaskStatusNotificationSender;
  try {
    const task = await taskStore.getTask(taskId);
    const normalized = await projectCancelledTaskStatus(
      taskStore,
      normalizeGetTaskResult(task)
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

function getTaskStore(extra: TaskToolExtra): RequestTaskStore {
  if (!extra.taskStore) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Task store not configured for task-capable tool.'
    );
  }
  return extra.taskStore;
}

function getTaskId(extra: TaskToolExtra): string {
  if (!extra.taskId) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Task id missing for task operation.'
    );
  }
  return extra.taskId;
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

const TERMINAL_TASK_STATUSES = new Set<GetTaskResult['status']>([
  'completed',
  'failed',
  'cancelled',
]);

async function isTaskAlreadyTerminal(
  taskStore: RequestTaskStore,
  taskId: string
): Promise<boolean> {
  try {
    const task = await taskStore.getTask(taskId);
    if (!isRecord(task)) return false;
    const { status } = task;
    return typeof status === 'string' && TERMINAL_TASK_STATUSES.has(status);
  } catch {
    return false;
  }
}

async function countActiveTasks(taskStore: RequestTaskStore): Promise<number> {
  if (typeof taskStore.listTasks !== 'function') return 0;
  const listed = await taskStore.listTasks();
  const tasks = Array.isArray(listed.tasks) ? listed.tasks : [];
  let active = 0;
  for (const task of tasks) {
    if (!isRecord(task) || typeof task.status !== 'string') continue;
    if (
      task.status !== 'completed' &&
      task.status !== 'failed' &&
      task.status !== 'cancelled'
    ) {
      active += 1;
    }
  }
  return active;
}

function resolveRequestedTaskTtl(
  requestedTtl: number | null | undefined
): number {
  if (requestedTtl == null) return DEFAULT_TASK_TTL_MS;
  if (!Number.isFinite(requestedTtl)) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Task ttl must be a finite number of milliseconds.'
    );
  }

  const normalized = Math.trunc(requestedTtl);
  if (normalized <= 0) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Task ttl must be greater than zero.'
    );
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
    // If task was already cancelled/failed by another process, ignore the write error
    if (await isTaskAlreadyTerminal(taskStore, taskId)) return;
    throw error;
  }
}

async function runTaskInBackground<Args extends ToolSchema>(
  run: (
    args: ToolArgs<Args>,
    extra: TaskToolExtra
  ) => Promise<ToolResult<unknown>>,
  args: ToolArgs<Args>,
  extra: TaskToolExtra,
  taskStore: RequestTaskStore,
  taskId: string,
  toolName?: string
): Promise<void> {
  const start = performance.now();
  let taskStatuses: TaskResultStatuses;
  let result: Result;

  try {
    const rawResult = await taskContext.run(
      { taskId, toolName, startTime: start },
      () => run(args, extra)
    );

    taskStatuses = resolveTaskResultStatuses(rawResult);
    result = isErrorResult(rawResult)
      ? withoutStructuredContent(rawResult)
      : maybeStripStructuredContentFromResult(rawResult);
  } catch (error) {
    taskStatuses = { storedStatus: 'failed', reportedStatus: 'failed' };
    result = maybeStripStructuredContentFromResult(
      buildToolErrorResponse(error, ErrorCode.E_UNKNOWN)
    );
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
    await notifyTaskStatusIfPossible(extra, taskStore, taskId, toolName);
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

    const { sendNotification } = extra as { sendNotification?: unknown };
    if (typeof sendNotification === 'function') {
      void (sendNotification as TaskStatusNotificationSender)({
        method: TASK_STATUS_NOTIFICATION_METHOD,
        params: buildTaskStatusNotificationParams(syntheticTask),
      });
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
  const tasks = getExperimentalTaskRegistration(server);
  if (!tasks?.registerToolTask) return false;

  const def = toolDef as Record<string, unknown>;
  const existingExecution =
    (def.execution as Record<string, unknown> | undefined) ?? {};
  const taskSupport =
    (def.taskSupport as string | undefined) ??
    (existingExecution.taskSupport as string | undefined) ??
    'forbidden';

  if (taskSupport === 'forbidden') return false;

  tasks.registerToolTask(
    toolName,
    withDefaultIcons(
      { ...toolDef, execution: { ...existingExecution, taskSupport } },
      iconInfo
    ),
    taskHandler
  );
  return true;
}

export function registerToolTaskIfAvailable<Args extends ToolSchema, Result>(
  server: McpServer,
  toolName: string,
  toolDef: object,
  run: (
    args: ToolArgs<Args>,
    extra: TaskToolExtra
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
    createToolTaskHandler(run, taskOptions),
    iconInfo
  );
}

export function createToolTaskHandler<Result>(
  run: (args: undefined, extra: TaskToolExtra) => Promise<ToolResult<Result>>,
  options?: { guard?: () => boolean; toolName?: string }
): ToolTaskHandler;
export function createToolTaskHandler<
  Args extends ZodRawShapeCompat | AnySchema,
  Result,
>(
  run: (
    args: ToolArgs<Args>,
    extra: TaskToolExtra
  ) => Promise<ToolResult<Result>>,
  options?: { guard?: () => boolean; toolName?: string }
): ToolTaskHandler<Args>;
export function createToolTaskHandler<Args extends ToolSchema, Result>(
  run: (
    args: ToolArgs<Args>,
    extra: TaskToolExtra
  ) => Promise<ToolResult<Result>>,
  options?: { guard?: () => boolean; toolName?: string }
): ToolTaskHandler<Args> {
  const createTask = (async (
    argsOrExtra: ToolArgs<Args> | CreateTaskRequestHandlerExtra,
    maybeExtra?: CreateTaskRequestHandlerExtra
  ): Promise<CreateTaskResult> => {
    const extra = asCreateTaskExtra(maybeExtra ?? argsOrExtra);
    const args = (maybeExtra ? argsOrExtra : undefined) as ToolArgs<Args>;

    if (options?.guard && !options.guard()) {
      throw new McpError(
        ErrorCode.E_INVALID_INPUT,
        'Client not initialized; wait for notifications/initialized'
      );
    }

    const taskStore = getTaskStore(extra);
    if ((await countActiveTasks(taskStore)) >= MAX_CONCURRENT_TASKS) {
      throw new McpError(
        ErrorCode.E_INVALID_INPUT,
        `Too many active tasks. Limit: ${String(MAX_CONCURRENT_TASKS)}.`
      );
    }
    const task = await taskStore.createTask({
      ttl: resolveRequestedTaskTtl(extra.taskRequestedTtl),
    });
    publishTaskDiagnostics({
      phase: 'task_created',
      taskId: task.taskId,
      status: task.status,
      ...(options?.toolName ? { toolName: options.toolName } : {}),
    });
    const taskExtra: TaskToolExtra = {
      ...extra,
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
      options?.toolName
    );
    return { task };
  }) as ToolTaskHandler<Args>['createTask'];

  const getTask = (async (
    argsOrExtra: ToolArgs<Args> | TaskRequestHandlerExtra,
    maybeExtra?: TaskRequestHandlerExtra
  ): Promise<GetTaskResult> => {
    const extra = asTaskRequestExtra(maybeExtra ?? argsOrExtra);
    const taskStore = getTaskStore(extra);
    const taskId = getTaskId(extra);
    const task = await taskStore.getTask(taskId);
    return projectCancelledTaskStatus(taskStore, normalizeGetTaskResult(task));
  }) as ToolTaskHandler<Args>['getTask'];

  const getTaskResult = (async (
    argsOrExtra: ToolArgs<Args> | TaskRequestHandlerExtra,
    maybeExtra?: TaskRequestHandlerExtra
  ): Promise<CallToolResult> => {
    const extra = asTaskRequestExtra(maybeExtra ?? argsOrExtra);
    const taskStore = getTaskStore(extra);
    const taskId = getTaskId(extra);
    const result = await taskStore.getTaskResult(taskId);
    return attachRelatedTaskMeta(normalizeCallToolResult(result), taskId);
  }) as ToolTaskHandler<Args>['getTaskResult'];

  return {
    createTask,
    getTask,
    getTaskResult,
  };
}
