import {
  type CallToolResult,
  type CreateTaskResult,
  type CreateTaskServerContext,
  type GetTaskResult,
  InMemoryTaskStore,
  RELATED_TASK_META_KEY,
  type Task,
  type TaskServerContext,
  type ToolTaskHandler,
} from '@modelcontextprotocol/server';
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { EventEmitter } from 'node:events';

import { ErrorCode, McpError } from './core/errors.js';
import {
  DEFAULT_TASK_TTL_MS,
  isRecord,
  MAX_CONCURRENT_TASKS,
  MAX_TASK_TTL_MS,
  maybeStripStructuredContentFromResult,
} from './core/util.js';
import { type ToolContext, type ToolResult, toToolContext } from './tools/_helpers.js';

// ═══════════════════════════════════════════════════════════════
// task-store
// ═══════════════════════════════════════════════════════════════

export class EventedTaskStore extends InMemoryTaskStore {
  public readonly events = new EventEmitter();

  override async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    await super.updateTaskStatus(taskId, status, statusMessage, sessionId);

    if (status === 'cancelled') {
      this.events.emit('cancelled', taskId);
    }
  }
}

export function createTaskStore(): EventedTaskStore {
  return new EventedTaskStore();
}

// ═══════════════════════════════════════════════════════════════
// task-orchestrator
// ═══════════════════════════════════════════════════════════════

/**
 * TaskOrchestrator manages the lifecycle of background tasks.
 * It connects the EventedTaskStore with the AbortControllers for cancellation,
 * and intercepts progress notifications to update task status in the store.
 */
export class TaskOrchestrator {
  private readonly controllers = new Map<string, AbortController>();
  private readonly store: EventedTaskStore;

  constructor(store: EventedTaskStore) {
    this.store = store;
    this.store.events.on('cancelled', (taskId: string) => {
      const controller = this.controllers.get(taskId);
      if (controller) {
        // Abort the background execution with a cancellation reason.
        controller.abort(new McpError(ErrorCode.CANCELLED, 'Task execution cancelled.'));
        this.controllers.delete(taskId);
      }
    });
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

          const requestedTtl =
            'taskRequestedTtl' in ctx && typeof ctx.taskRequestedTtl === 'number'
              ? ctx.taskRequestedTtl
              : DEFAULT_TASK_TTL_MS;
          const ttl = Math.min(requestedTtl, MAX_TASK_TTL_MS);

          // Create the task record in the store.
          return task.store.createTask({
            ttl,
          });
        }))) as Task;

      const controller = new AbortController();
      this.controllers.set(mcpTask.taskId, controller);

      // Start background execution without awaiting it.
      this.executeBackground(mcpTask.taskId, handler, args, ctx, options.toolName).catch(
        (error: unknown) => {
          console.error(
            `[TaskOrchestrator] Fatal error in background task ${mcpTask.taskId}:`,
            error,
          );
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
    toolName: string,
  ): Promise<void> {
    const { task } = serverCtx;

    const controller = this.controllers.get(taskId);
    const signal = controller?.signal;

    try {
      // Set initial status message
      await task.store.updateTaskStatus(taskId, 'working', `${toolName}: starting`);

      const toolCtx = toToolContext(serverCtx);
      const interceptedCtx: ToolContext = {
        ...toolCtx,
        ...(signal ? { signal } : {}),
        sendNotification: async (notification) => {
          // Intercept progress notifications to update task status
          if (notification.method === 'notifications/tasks/status') {
            const params = notification.params as Record<string, unknown>;
            const status = (
              typeof params['status'] === 'string' ? params['status'] : 'working'
            ) as Task['status'];
            const statusMessage =
              typeof params['statusMessage'] === 'string' ? params['statusMessage'] : '';

            await task.store.updateTaskStatus(taskId, status, `${toolName}: ${statusMessage}`);
          } else {
            // Forward other notifications normally
            await toolCtx.sendNotification?.(notification);
          }
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

      if (strippedResult.isError) {
        const isCancelled = strippedResult.errorCode === ErrorCode.CANCELLED;
        if (isCancelled) {
          try {
            await task.store.updateTaskStatus(taskId, 'cancelled', `${toolName}: cancelled`);
          } catch {
            // ignore
          }
        } else {
          await task.store.storeTaskResult(taskId, 'failed', strippedResult);
        }
      } else {
        await task.store.storeTaskResult(taskId, 'completed', strippedResult);
      }
    } catch (error: unknown) {
      // If we are here, the task might have been cancelled from the outside (store event)
      // or the handler failed.
      const isCancelled =
        (isRecord(error) && error['code'] === ErrorCode.CANCELLED) || signal?.aborted === true;

      if (isCancelled) {
        try {
          // Only update status if it's not already cancelled or terminal.
          const current = await task.store.getTask(taskId);
          if (current.status !== 'cancelled') {
            await task.store.updateTaskStatus(taskId, 'cancelled', `${toolName}: cancelled`);
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
