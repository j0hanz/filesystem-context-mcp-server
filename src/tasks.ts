import {
  type CallToolResult,
  type CreateTaskResult,
  type CreateTaskServerContext,
  type GetTaskResult,
  InMemoryTaskStore,
  isTerminal,
  RELATED_TASK_META_KEY,
  type Task,
  type TaskServerContext,
  type TaskStatus,
  type ToolTaskHandler,
} from '@modelcontextprotocol/server';
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { ErrorCode, McpError } from './core/errors.js';
import { logRuntimeFailure } from './core/observability.js';
import {
  isRecord,
  MAX_CONCURRENT_TASKS,
  MAX_TASK_TTL_MS,
  maybeStripStructuredContentFromResult,
  TASK_POLL_INTERVAL,
  TASK_TTL,
} from './core/util.js';
import { type ToolContext, type ToolResult, toToolContext } from './tools/_helpers.js';

export const TASK_PROGRESS_STATUS_MESSAGE = 'filesystem-mcp: processing request';

// ═══════════════════════════════════════════════════════════════
// task-orchestrator
// ═══════════════════════════════════════════════════════════════

/**
 * TaskOrchestrator manages the lifecycle of background tasks and acts as the
 * authoritative TaskStore for the MCP server. It connects task status updates
 * (like cancellation) directly to AbortControllers for background tool handlers.
 */
export class TaskOrchestrator extends InMemoryTaskStore {
  private readonly controllers = new Map<string, AbortController>();
  private disposed = false;

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.controllers.values()) {
      controller.abort(new McpError(ErrorCode.CANCELLED, 'Orchestrator shutting down.'));
    }
    this.controllers.clear();
  }

  override async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    await super.updateTaskStatus(taskId, status, statusMessage, sessionId);

    if (status === 'cancelled') {
      const controller = this.controllers.get(taskId);
      if (controller) {
        // Abort the background execution with a cancellation reason.
        controller.abort(new McpError(ErrorCode.CANCELLED, 'Task execution cancelled.'));
        this.controllers.delete(taskId);
      }
    }
  }

  private creationPromise: Promise<unknown> = Promise.resolve();

  /**
   * Wraps a pure tool handler into an MCP-compliant ToolTaskHandler.
   * This handles the background execution logic, state management, and interception.
   * Supports both (ctx, args) and (args, ctx) signatures from the SDK.
   */
  public wrapToolTask<
    Args extends StandardSchemaWithJSON | undefined,
    Result extends Record<string, unknown>,
  >(
    handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult<Result>>,
    options: { toolName: string },
  ): ToolTaskHandler<Args> {
    const createTask = (async (
      ...params: [unknown, CreateTaskServerContext] | [CreateTaskServerContext]
    ): Promise<CreateTaskResult> => {
      let args: unknown;
      let ctx: CreateTaskServerContext;
      if (params.length === 1) {
        ctx = params[0];
        args = undefined;
      } else {
        [args, ctx] = params;
      }

      const { task } = ctx;

      const mcpTask = (await (this.creationPromise = this.creationPromise
        .catch(() => undefined)
        .then(async () => {
          // Check max concurrent tasks
          let activeCount = 0;
          let cursor: string | undefined;
          do {
            const page = await task.store.listTasks(cursor);
            activeCount += page.tasks.filter((t: Task) => t.status === 'working').length;
            cursor = page.nextCursor;
          } while (cursor);

          if (activeCount >= MAX_CONCURRENT_TASKS) {
            throw new McpError(ErrorCode.INVALID_INPUT, `Too many active tasks (${activeCount})`);
          }

          const requestedTtl = ctx.task.requestedTtl ?? TASK_TTL;
          const ttl = Math.min(requestedTtl, MAX_TASK_TTL_MS);

          // Create the task record in the store.
          return task.store.createTask({
            ttl,
            pollInterval: TASK_POLL_INTERVAL,
          });
        }))) as Task;

      const controller = new AbortController();
      this.controllers.set(mcpTask.taskId, controller);

      await task.store.updateTaskStatus(mcpTask.taskId, 'working', TASK_PROGRESS_STATUS_MESSAGE);

      // Start background execution without awaiting it.
      this.executeBackground(mcpTask.taskId, handler, args, ctx, options.toolName).catch(
        (error: unknown) => {
          logRuntimeFailure('background_task_fatal', 'task_orchestrator', options.toolName, error);
        },
      );

      return { task: mcpTask };
    }) as ToolTaskHandler<Args>['createTask'];

    const getTask = (async (
      ...params: [unknown, TaskServerContext] | [TaskServerContext]
    ): Promise<GetTaskResult> => {
      const ctx = params.length === 1 ? params[0] : params[1];
      const { task } = ctx;
      return task.store.getTask(task.id);
    }) as ToolTaskHandler<Args>['getTask'];

    const getTaskResult = (async (
      ...params: [unknown, TaskServerContext] | [TaskServerContext]
    ): Promise<CallToolResult | undefined> => {
      const ctx = params.length === 1 ? params[0] : params[1];
      const { task } = ctx;
      return task.store.getTaskResult(task.id) as Promise<CallToolResult | undefined>;
    }) as ToolTaskHandler<Args>['getTaskResult'];

    return {
      createTask,
      getTask,
      getTaskResult,
    };
  }

  /**
   * Executes the tool handler in the background, handling progress and results.
   */
  private async executeBackground<Args, Result extends Record<string, unknown>>(
    taskId: string,
    handler: (args: Args, ctx: ToolContext) => Promise<ToolResult<Result>>,
    args: Args,
    serverCtx: CreateTaskServerContext,
    _toolName: string,
  ): Promise<void> {
    const { task } = serverCtx;

    const controller = this.controllers.get(taskId);
    const signal = controller?.signal;

    try {
      const toolCtx = toToolContext(serverCtx);

      const interceptedCtx: ToolContext = {
        ...toolCtx,
        ...(signal ? { signal } : {}),
        sendNotification: async (notification) => {
          // Ignore wrapped task status notifications to avoid spoof/desync risk
          // against the authoritative task state managed by the orchestrator/store.
          if (notification.method === 'notifications/tasks/status') {
            return;
          }
          await toolCtx.sendNotification?.(notification);
        },
      };

      const result = await handler(args, interceptedCtx);

      const strippedResult = maybeStripStructuredContentFromResult(result);
      if (
        strippedResult['_meta'] &&
        typeof strippedResult['_meta'] === 'object' &&
        'io.modelcontextprotocol/model-immediate-response' in strippedResult['_meta']
      ) {
        // Create a copy to avoid mutating the original
        strippedResult['_meta'] = { ...strippedResult['_meta'] };
        delete (strippedResult['_meta'] as Record<string, unknown>)[
          'io.modelcontextprotocol/model-immediate-response'
        ];
      }

      // Ensure _meta exists and attach RELATED_TASK_META_KEY
      strippedResult['_meta'] = {
        ...(typeof strippedResult['_meta'] === 'object' && strippedResult['_meta'] !== null
          ? strippedResult['_meta']
          : {}),
        [RELATED_TASK_META_KEY]: { taskId },
      };

      if ('isError' in strippedResult && strippedResult['isError'] === true) {
        const isCancelled = strippedResult['errorCode'] === ErrorCode.CANCELLED;
        if (isCancelled) {
          try {
            await task.store.updateTaskStatus(taskId, 'cancelled', 'cancelled');
          } catch {
            // ignore
          }
        } else {
          await task.store.storeTaskResult(taskId, 'failed', strippedResult);
        }
      } else {
        // Only update message to 'completed' if no progress was reported during execution
        // to preserve the final progress message from the tool
        await task.store.storeTaskResult(taskId, 'completed', strippedResult);
      }
    } catch (error: unknown) {
      // If we are here, the task might have been cancelled from the outside (store event)
      // or the handler failed.
      const isCancelled =
        (isRecord(error) && error['code'] === ErrorCode.CANCELLED) || signal?.aborted === true;

      if (isCancelled) {
        try {
          // Only update status if it's not already in a terminal state.
          const current = await task.store.getTask(taskId);
          if (!isTerminal(current.status)) {
            await task.store.updateTaskStatus(taskId, 'cancelled', 'cancelled');
          }
        } catch {
          // Best effort for terminal tasks
        }
      } else {
        const message =
          isRecord(error) && typeof error['message'] === 'string'
            ? error['message']
            : String(error);
        const code = (
          isRecord(error) && typeof error['code'] === 'string' ? error['code'] : ErrorCode.UNKNOWN
        ) as ErrorCode;

        // Store the failure result
        const errorResult = {
          isError: true as const,
          content: [{ type: 'text' as const, text: message }],
          errorCode: code,
          _meta: {
            [RELATED_TASK_META_KEY]: { taskId },
          },
        };
        await task.store.storeTaskResult(
          taskId,
          'failed',
          maybeStripStructuredContentFromResult(errorResult),
        );
      }
    } finally {
      this.controllers.delete(taskId);
    }
  }
}
