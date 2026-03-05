import { channel } from 'node:diagnostics_channel';

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
import type {
  CallToolResult,
  CreateTaskResult,
  GetTaskResult,
  Result,
  TaskStatusNotificationParams,
} from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

import { ErrorCode, McpError } from '../lib/errors.js';
import { isRecord } from '../lib/utils.js';

import type { IconInfo, ToolExtra, ToolResult } from './shared.js';
import {
  buildToolErrorResponse,
  maybeStripStructuredContentFromResult,
  withDefaultIcons,
} from './shared.js';

function isExperimentalTaskRegistration(
  value: unknown
): value is { registerToolTask?: (...args: unknown[]) => unknown } {
  if (!value || typeof value !== 'object') return false;
  const { registerToolTask } = value as { registerToolTask?: unknown };
  return (
    registerToolTask === undefined || typeof registerToolTask === 'function'
  );
}

function getExperimentalTaskRegistration(
  server: McpServer
): { registerToolTask?: (...args: unknown[]) => unknown } | undefined {
  const serverWithExperimental = server as { experimental?: unknown };
  const { experimental } = serverWithExperimental;
  if (!experimental || typeof experimental !== 'object') return undefined;
  const { tasks } = experimental as { tasks?: unknown };
  if (!isExperimentalTaskRegistration(tasks)) return undefined;
  return tasks;
}

function hasTaskToolCapability(server: McpServer): boolean {
  const serverRecord = server as unknown as Record<string, unknown>;
  const { server: serverRuntime } = serverRecord;
  if (!isRecord(serverRuntime)) return true;
  const { getCapabilities } = serverRuntime;
  if (typeof getCapabilities !== 'function') {
    // Fallback for tests or custom wrappers that provide only registerTool/experimental.
    return true;
  }

  const capabilities = (getCapabilities as () => unknown).call(serverRuntime);
  if (!isRecord(capabilities)) return false;
  const { tasks } = capabilities;
  if (!isRecord(tasks)) return false;
  const { requests } = tasks;
  if (!isRecord(requests)) return false;
  const { tools } = requests;
  if (!isRecord(tools)) return false;
  const { call } = tools;
  return isRecord(call);
}

type TaskToolExtra = ToolExtra & {
  taskId?: string;
  taskStore?: RequestTaskStore;
  taskRequestedTtl?: number | null;
};

type ToolArgs<Args extends ZodRawShapeCompat | AnySchema | undefined> =
  Args extends ZodRawShapeCompat
    ? ShapeOutput<Args>
    : Args extends AnySchema
      ? SchemaOutput<Args>
      : undefined;

const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';
const TASK_STATUS_NOTIFICATION_METHOD = 'notifications/tasks/status';

interface TaskDiagnosticsEvent {
  phase:
    | 'task_created'
    | 'task_result_stored'
    | 'task_status_notified'
    | 'task_status_notify_failed';
  taskId: string;
  status?: GetTaskResult['status'] | 'completed' | 'failed';
  toolName?: string;
}

const TASK_DIAGNOSTICS_CHANNEL = channel('filesystem-mcp:tasks');

function publishTaskDiagnostics(event: TaskDiagnosticsEvent): void {
  if (!TASK_DIAGNOSTICS_CHANNEL.hasSubscribers) return;
  TASK_DIAGNOSTICS_CHANNEL.publish(event);
}

function isRequestTaskStore(value: unknown): value is RequestTaskStore {
  if (!isRecord(value)) return false;
  return (
    typeof value['createTask'] === 'function' &&
    typeof value['getTask'] === 'function' &&
    typeof value['storeTaskResult'] === 'function' &&
    typeof value['getTaskResult'] === 'function'
  );
}

function isCreateTaskExtra(
  value: unknown
): value is CreateTaskRequestHandlerExtra {
  return isRecord(value) && isRequestTaskStore(value['taskStore']);
}

function isTaskExtra(value: unknown): value is TaskRequestHandlerExtra {
  return (
    isCreateTaskExtra(value) &&
    typeof value['taskId'] === 'string' &&
    value['taskId'].length > 0
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

function parseTaskStatus(value: unknown): GetTaskResult['status'] | undefined {
  return isTaskStatus(value) ? value : undefined;
}

function normalizeGetTaskResult(value: unknown): GetTaskResult {
  if (!isRecord(value) || typeof value['taskId'] !== 'string') {
    throw new McpError(ErrorCode.E_INVALID_INPUT, 'Invalid task object.');
  }

  const status = parseTaskStatus(value['status']);
  if (!status) {
    throw new McpError(ErrorCode.E_INVALID_INPUT, 'Invalid task status.');
  }

  const createdAt =
    typeof value['createdAt'] === 'string'
      ? value['createdAt']
      : new Date().toISOString();
  const lastUpdatedAt =
    typeof value['lastUpdatedAt'] === 'string'
      ? value['lastUpdatedAt']
      : createdAt;
  const ttl = typeof value['ttl'] === 'number' ? value['ttl'] : null;

  const normalized: GetTaskResult = {
    taskId: value['taskId'],
    status,
    ttl,
    createdAt,
    lastUpdatedAt,
  };

  if (typeof value['pollInterval'] === 'number') {
    normalized.pollInterval = value['pollInterval'];
  }
  if (typeof value['statusMessage'] === 'string') {
    normalized.statusMessage = value['statusMessage'];
  }
  if (isRecord(value['_meta'])) {
    normalized._meta = value['_meta'];
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
  if (!isRecord(result) || result['isError'] !== true) return undefined;
  // First check for a dedicated errorCode property to avoid regex parsing of the content for structured error results produced by newer code.
  if (typeof result['errorCode'] === 'string') return result['errorCode'];
  // Fallback to regex parsing of the human-readable error message for older error results that lack a structured errorCode property.
  const { content } = result;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first: unknown = content[0];
  if (!isRecord(first) || first['type'] !== 'text') return undefined;
  const { text } = first;
  if (typeof text !== 'string') return undefined;
  const match = /^Error \[([A-Z0-9_]+)\]:/.exec(text);
  return match ? match[1] : undefined;
}

function isCancelledToolResult(result: Result): boolean {
  return getToolResultErrorCode(result) === ErrorCode.E_CANCELLED;
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

function withRelatedTaskMeta(result: Result, taskId: string): Result {
  const existingMeta = isRecord(result['_meta']) ? result['_meta'] : {};
  return {
    ...result,
    _meta: { ...existingMeta, [RELATED_TASK_META_KEY]: { taskId } },
  };
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
      ...(toolName !== undefined ? { toolName } : {}),
    });
  } catch {
    publishTaskDiagnostics({
      phase: 'task_status_notify_failed',
      taskId,
      ...(toolName !== undefined ? { toolName } : {}),
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

// Strips structuredContent from a tool result if present, without modifying the original object.  This is used when storing error results as 'completed' to prevent client-side output schema validation errors, while still allowing the human-readable error message in content[0].text to be returned to clients.
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

async function tryStoreTaskResult(
  taskStore: RequestTaskStore,
  taskId: string,
  status: 'completed' | 'failed',
  result: Result
): Promise<void> {
  const resultWithTaskMeta = withRelatedTaskMeta(result, taskId);
  try {
    await taskStore.storeTaskResult(taskId, status, resultWithTaskMeta);
  } catch (error) {
    if (await isTaskAlreadyTerminal(taskStore, taskId)) return;
    throw error;
  }
}

async function runTaskInBackground<
  Args extends ZodRawShapeCompat | AnySchema | undefined,
>(
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
  try {
    const rawResult = await run(args, extra);
    const status = isCancelledToolResult(rawResult) ? 'failed' : 'completed';
    const result =
      isErrorResult(rawResult) && status === 'completed'
        ? withoutStructuredContent(rawResult)
        : maybeStripStructuredContentFromResult(rawResult);
    await tryStoreTaskResult(taskStore, taskId, status, result);
    publishTaskDiagnostics({
      phase: 'task_result_stored',
      taskId,
      status,
      ...(toolName !== undefined ? { toolName } : {}),
    });
    await notifyTaskStatusIfPossible(extra, taskStore, taskId, toolName);
  } catch (error) {
    const fallback = maybeStripStructuredContentFromResult(
      buildToolErrorResponse(error, ErrorCode.E_UNKNOWN)
    );
    try {
      await tryStoreTaskResult(taskStore, taskId, 'failed', fallback);
      publishTaskDiagnostics({
        phase: 'task_result_stored',
        taskId,
        status: 'failed',
        ...(toolName !== undefined ? { toolName } : {}),
      });
      await notifyTaskStatusIfPossible(extra, taskStore, taskId, toolName);
    } catch (innerError) {
      console.error(
        `Failed to store task failure result for task ${taskId}:`,
        innerError
      );
      // If storing the failure result also fails, there's not much we can do. The task will remain in 'working' status until it expires, which is not ideal but at least prevents clients from receiving incorrect results or hanging indefinitely waiting for a result that will never arrive. We log the error to aid debugging, and we attempt to notify the client of the failure if possible, but we don't want to throw further errors that could crash the server or cause cascading failures.
      const syntheticTask: GetTaskResult = {
        taskId,
        status: 'failed',
        ttl: null,
        createdAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
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
}

/**
 * Registers a tool preferring task-capable registration when available, and
 * returns `true`. Returns `false` so the caller can fall through to standard
 * `server.registerTool`.
 */
function tryRegisterToolTask<
  Args extends ZodRawShapeCompat | AnySchema | undefined,
>(
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
    'optional';

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

export function registerToolTaskIfAvailable<
  Args extends ZodRawShapeCompat | AnySchema | undefined,
  Result,
>(
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
export function createToolTaskHandler<
  Args extends ZodRawShapeCompat | AnySchema | undefined,
  Result,
>(
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
    const task = await taskStore.createTask({
      ttl: extra.taskRequestedTtl ?? null,
    });
    publishTaskDiagnostics({
      phase: 'task_created',
      taskId: task.taskId,
      status: task.status,
      ...(options?.toolName !== undefined
        ? { toolName: options.toolName }
        : {}),
    });
    const taskExtra: TaskToolExtra = {
      ...extra,
      taskStore,
      taskId: task.taskId,
    };
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
    return normalizeCallToolResult(withRelatedTaskMeta(result, taskId));
  }) as ToolTaskHandler<Args>['getTaskResult'];

  return {
    createTask,
    getTask,
    getTaskResult,
  };
}
