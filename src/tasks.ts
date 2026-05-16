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
  type TaskStore,
  type ToolTaskHandler,
} from '@modelcontextprotocol/server';
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { ErrorCode, FsError } from './core/errors.js';
import { plainMessage } from './core/fmt.js';
import { logRuntimeFailure } from './core/observability.js';
import {
  isRecord,
  MAX_CONCURRENT_TASKS,
  MAX_TASK_TTL_MS,
  maybeStripStructuredContentFromResult,
  TASK_POLL_INTERVAL,
  TASK_TTL,
} from './core/util.js';
import { type ToolCtx, type ToolDeps, type ToolResult, toToolCtx } from './tools/define.js';

// ═══════════════════════════════════════════════════════════════
// task-orchestrator
// ═══════════════════════════════════════════════════════════════

class TaskRunner {
  private readonly controllers = new Map<string, AbortController>();

  abortAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort(new FsError(ErrorCode.CANCELLED, 'Orchestrator shutting down.'));
    }
    this.controllers.clear();
  }

  abort(taskId: string, reason = 'Task execution cancelled.'): void {
    const controller = this.controllers.get(taskId);
    if (controller) {
      controller.abort(new FsError(ErrorCode.CANCELLED, reason));
      this.controllers.delete(taskId);
    }
  }

  register(taskId: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    return controller;
  }

  async execute(taskId: string, fn: (signal?: AbortSignal) => Promise<void>): Promise<void> {
    const controller = this.controllers.get(taskId);
    try {
      await fn(controller?.signal);
    } finally {
      this.controllers.delete(taskId);
    }
  }
}

class AsyncMutex {
  private promise = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.promise;
    let resolveFn: (() => void) | undefined;
    this.promise = new Promise<void>((r) => {
      resolveFn = r;
    });

    try {
      await prev;
      return await fn();
    } finally {
      if (resolveFn) resolveFn();
    }
  }
}

/**
 * TaskOrchestrator manages the lifecycle of background tasks and acts as the
 * authoritative TaskStore for the MCP server. It connects task status updates
 * (like cancellation) directly to AbortControllers via TaskRunner.
 */
export class TaskOrchestrator implements TaskStore {
  private readonly runner = new TaskRunner();
  private readonly store = new InMemoryTaskStore();
  private readonly creationMutex = new AsyncMutex();
  private disposed = false;

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.runner.abortAll();
  }

  // TaskStore delegation
  async createTask(
    params: Parameters<TaskStore['createTask']>[0],
    requestId: Parameters<TaskStore['createTask']>[1],
    request: Parameters<TaskStore['createTask']>[2],
    sessionId?: string,
  ): Promise<Task> {
    return this.store.createTask(params, requestId, request, sessionId);
  }

  async getTask(taskId: string, sessionId?: string): Promise<Task> {
    const task = await this.store.getTask(taskId, sessionId);
    if (!task) {
      throw new FsError(ErrorCode.NOT_FOUND, 'Task not found');
    }
    return task;
  }

  async listTasks(cursor?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    return this.store.listTasks(cursor);
  }

  async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Record<string, unknown>,
    sessionId?: string,
  ): Promise<void> {
    return this.store.storeTaskResult(taskId, status, result, sessionId);
  }

  async getTaskResult(taskId: string, sessionId?: string): Promise<Record<string, unknown>> {
    const res = await this.store.getTaskResult(taskId, sessionId);
    return res;
  }

  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    await this.store.updateTaskStatus(taskId, status, statusMessage, sessionId);

    if (status === 'cancelled') {
      this.runner.abort(taskId);
    }
  }

  // To satisfy TaskStore extension needs if it has any extra internal properties,
  // we may need to delegate cleanup. The InMemoryTaskStore has cleanup().
  public cleanup(): void {
    this.store.cleanup();
  }

  public wrapToolTask<
    Args extends StandardSchemaWithJSON | undefined,
    Result extends Record<string, unknown>,
  >(
    handler: (args: unknown, ctx: ToolCtx) => Promise<ToolResult<Result>>,
    options: {
      toolName: string;
      toolTitle?: string;
      deps: Pick<ToolDeps, 'pathGuard' | 'resourceStore'>;
    },
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

      const mcpTask = await this.creationMutex.run(async () => {
        let activeCount = 0;
        let cursor: string | undefined;
        do {
          const page = await task.store.listTasks(cursor);
          activeCount += page.tasks.filter((t: Task) => t.status === 'working').length;
          cursor = page.nextCursor;
        } while (cursor);

        if (activeCount >= MAX_CONCURRENT_TASKS) {
          throw new FsError(ErrorCode.INVALID_INPUT, `Too many active tasks (${activeCount})`);
        }

        const requestedTtl = ctx.task.requestedTtl ?? TASK_TTL;
        const ttl = Math.min(requestedTtl, MAX_TASK_TTL_MS);

        return task.store.createTask({
          ttl,
          pollInterval: TASK_POLL_INTERVAL,
        });
      });

      this.runner.register(mcpTask.taskId);

      await task.store.updateTaskStatus(
        mcpTask.taskId,
        'working',
        plainMessage('start', { label: options.toolTitle ?? options.toolName }),
      );

      this.runner
        .execute(mcpTask.taskId, async (execSignal) => {
          try {
            const baseCtx = toToolCtx(ctx, options.deps);

            const interceptedCtx: ToolCtx = {
              ...baseCtx,
              ...(execSignal ? { signal: execSignal } : {}),
              sendNotification: async (notification) => {
                if (notification.method === 'notifications/tasks/status') {
                  return;
                }
                await baseCtx.sendNotification?.(notification);
              },
            };

            const result = await handler(args, interceptedCtx);

            const strippedResult = maybeStripStructuredContentFromResult(result);
            if (
              strippedResult['_meta'] &&
              typeof strippedResult['_meta'] === 'object' &&
              'io.modelcontextprotocol/model-immediate-response' in strippedResult['_meta']
            ) {
              strippedResult['_meta'] = { ...strippedResult['_meta'] };
              delete (strippedResult['_meta'] as Record<string, unknown>)[
                'io.modelcontextprotocol/model-immediate-response'
              ];
            }

            strippedResult['_meta'] = {
              ...(typeof strippedResult['_meta'] === 'object' && strippedResult['_meta'] !== null
                ? strippedResult['_meta']
                : {}),
              [RELATED_TASK_META_KEY]: { taskId: mcpTask.taskId },
            };

            if ('isError' in strippedResult && strippedResult['isError'] === true) {
              const isCancelled = strippedResult['errorCode'] === ErrorCode.CANCELLED;
              if (isCancelled) {
                try {
                  await task.store.updateTaskStatus(mcpTask.taskId, 'cancelled', 'cancelled');
                } catch {
                  // ignore
                }
              } else {
                await task.store.storeTaskResult(mcpTask.taskId, 'failed', strippedResult);
              }
            } else {
              await task.store.storeTaskResult(mcpTask.taskId, 'completed', strippedResult);
            }
          } catch (error: unknown) {
            const isCancelled =
              (isRecord(error) && error['code'] === ErrorCode.CANCELLED) ||
              execSignal?.aborted === true;

            if (isCancelled) {
              try {
                const current = await task.store.getTask(mcpTask.taskId);
                if (!isTerminal(current.status)) {
                  await task.store.updateTaskStatus(mcpTask.taskId, 'cancelled', 'cancelled');
                }
              } catch {
                // Best effort
              }
            } else {
              const message =
                isRecord(error) && typeof error['message'] === 'string'
                  ? error['message']
                  : String(error);
              const code = (
                isRecord(error) && typeof error['code'] === 'string'
                  ? error['code']
                  : ErrorCode.UNKNOWN
              ) as ErrorCode;

              const errorResult = {
                isError: true as const,
                content: [{ type: 'text' as const, text: message }],
                errorCode: code,
                _meta: {
                  [RELATED_TASK_META_KEY]: { taskId: mcpTask.taskId },
                },
              };
              await task.store.storeTaskResult(
                mcpTask.taskId,
                'failed',
                maybeStripStructuredContentFromResult(errorResult),
              );
            }
          }
        })
        .catch((error: unknown) => {
          logRuntimeFailure('background_task_fatal', 'task_orchestrator', options.toolName, error);
        });

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
}
