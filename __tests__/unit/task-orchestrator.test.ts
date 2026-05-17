import {
  type CallToolResult,
  type CreateTaskServerContext,
  type Task,
  type TaskServerContext,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode } from '../../src/core/errors.js';
import type { PathGuard } from '../../src/core/path.js';
import { TaskOrchestrator } from '../../src/tasks.js';
import { type ToolCtx, type ToolDeps } from '../../src/tools/define.js';

const stubDeps: Pick<ToolDeps, 'pathGuard' | 'resourceStore'> = {
  pathGuard: {} as PathGuard,
  resourceStore: undefined,
};

function createMockExtra(
  store: TaskOrchestrator,
  sessionId = 'test-session',
): CreateTaskServerContext {
  let reqId = 0;
  return {
    mcpReq: {
      id: 1,
      method: 'tools/call',
      signal: new AbortController().signal,
      notify: async () => {},
      send: async () => ({}) as never,
      log: async () => {},
      elicitInput: async () => ({}) as never,
      requestSampling: async () => ({}) as never,
    },
    sessionId,
    task: {
      store: {
        async createTask(params: { ttl?: number }) {
          reqId++;
          return store.createTask(params, reqId, { method: 'tools/call', params: {} }, sessionId);
        },
        async getTask(taskId: string) {
          const t = await store.getTask(taskId, sessionId);
          if (!t) throw new Error(`Task with ID ${taskId} not found`);
          return t;
        },
        async updateTaskStatus(taskId: string, status: Task['status'], statusMessage?: string) {
          await store.updateTaskStatus(taskId, status, statusMessage, sessionId);
        },
        async storeTaskResult(
          taskId: string,
          status: 'completed' | 'failed',
          result: CallToolResult,
        ) {
          await store.storeTaskResult(taskId, status, result, sessionId);
        },
        async getTaskResult(taskId: string) {
          return store.getTaskResult(taskId, sessionId);
        },
        async listTasks(cursor?: string) {
          return store.listTasks(cursor, sessionId);
        },
      },
    },
  };
}

function createMockTaskExtra(
  store: TaskOrchestrator,
  taskId: string,
  sessionId = 'test-session',
): TaskServerContext {
  const base = createMockExtra(store, sessionId);
  return {
    ...base,
    task: {
      store: base.task.store,
      id: taskId,
    },
  };
}

describe('TaskOrchestrator', () => {
  it('executes a tool task successfully in background', async () => {
    const orchestrator = new TaskOrchestrator();
    const store = orchestrator;

    try {
      let executed = false;
      const handler = orchestrator.wrapToolTask(
        async (_args: unknown, _ctx: ToolCtx) => {
          executed = true;
          return {
            content: [{ type: 'text', text: 'success' }],
            structuredContent: { ok: true },
          };
        },
        { toolName: 'test_tool', deps: stubDeps },
      );

      const ctx = createMockExtra(orchestrator);
      const { task } = await handler.createTask(undefined as never, ctx);

      // Wait for background execution
      for (let i = 0; i < 10; i++) {
        const current = await store.getTask(task.taskId, 'test-session');
        if (current?.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 10));
      }

      const final = await store.getTask(task.taskId, 'test-session');
      assert.strictEqual(final?.status, 'completed');
      assert.strictEqual(executed, true);

      const result = await handler.getTaskResult(
        undefined as never,
        createMockTaskExtra(store, task.taskId),
      );
      assert.ok(result);
      assert.strictEqual(result?.content[0]?.type, 'text');
      if (result?.content[0]?.type === 'text') {
        assert.strictEqual(result.content[0].text, 'success');
      }
    } finally {
      store.cleanup();
    }
  });

  it('cancels background execution when store emits cancelled event', async () => {
    const orchestrator = new TaskOrchestrator();
    const store = orchestrator;

    try {
      let cancelled = false;
      const handler = orchestrator.wrapToolTask(
        async (_args: unknown, ctx: ToolCtx) => {
          try {
            if (ctx.signal?.aborted) {
              throw ctx.signal.reason as Error;
            }
            await new Promise((resolve, reject) => {
              const onAbort = () => {
                clearTimeout(timer);
                reject(ctx.signal?.reason as Error);
              };
              ctx.signal?.addEventListener('abort', onAbort);
              const timer = setTimeout(() => {
                ctx.signal?.removeEventListener('abort', onAbort);
                resolve(null);
              }, 1000);
            });
          } catch (e: unknown) {
            if (
              e instanceof Error &&
              (('code' in e && (e as { code: string }).code === ErrorCode.CANCELLED) ||
                e.name === 'AbortError')
            ) {
              cancelled = true;
            }
            throw e;
          }
          return { content: [], structuredContent: {} };
        },
        { toolName: 'test_tool', deps: stubDeps },
      );

      const ctx = createMockExtra(store);
      const { task } = await handler.createTask(undefined as never, ctx);

      // Trigger cancellation in store
      await store.updateTaskStatus(task.taskId, 'cancelled', 'User cancelled', 'test-session');

      // Wait for cleanup
      for (let i = 0; i < 20; i++) {
        if (cancelled) break;
        await new Promise((r) => setTimeout(r, 10));
      }

      assert.strictEqual(cancelled, true, 'Task should have been cancelled via signal');
    } finally {
      store.cleanup();
    }
  });

  it('drops wrapped notifications/tasks/status and does not translate them into store status updates', async () => {
    const orchestrator = new TaskOrchestrator();
    const store = orchestrator;

    try {
      const notifications: unknown[] = [];
      let emittedStatusNotification = false;
      let releaseHandler: (() => void) | undefined;
      const blocked = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      const handler = orchestrator.wrapToolTask(
        async (_args: unknown, ctx: ToolCtx) => {
          emittedStatusNotification = true;
          if (ctx.sendNotification) {
            await ctx.sendNotification({
              method: 'notifications/tasks/status',
              params: {
                taskId: 'ignored',
                status: 'working',
                statusMessage: 'Custom progress message',
              },
            });
          }
          await blocked;
          return {
            content: [{ type: 'text', text: 'done' }],
            structuredContent: {},
          };
        },
        { toolName: 'test_tool', deps: stubDeps },
      );

      const baseCtx = createMockExtra(store);
      let statusUpdateCalls = 0;
      const originalUpdateTaskStatus = baseCtx.task.store.updateTaskStatus.bind(baseCtx.task.store);
      const ctx = {
        ...baseCtx,
        task: {
          ...baseCtx.task,
          store: {
            ...baseCtx.task.store,
            updateTaskStatus: async (
              taskId: string,
              status: Task['status'],
              statusMessage?: string,
            ) => {
              statusUpdateCalls++;
              await originalUpdateTaskStatus(taskId, status, statusMessage);
            },
          },
        },
        mcpReq: {
          ...baseCtx.mcpReq,
          notify: async (notification: unknown) => {
            notifications.push(notification);
          },
        },
      } as CreateTaskServerContext;
      const { task } = await handler.createTask(undefined as never, ctx);

      for (let i = 0; i < 20; i++) {
        if (emittedStatusNotification) {
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      const midTask = await store.getTask(task.taskId, 'test-session');
      assert.strictEqual(midTask?.status, 'working');
      assert.strictEqual(midTask?.statusMessage, 'test_tool:');
      assert.equal(statusUpdateCalls, 1);

      releaseHandler?.();

      // Wait for background execution to complete.
      for (let i = 0; i < 10; i++) {
        const current = await store.getTask(task.taskId, 'test-session');
        if (current?.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 10));
      }

      const final = await store.getTask(task.taskId, 'test-session');
      assert.strictEqual(final?.status, 'completed');
      assert.equal(notifications.length, 0);
      assert.equal(statusUpdateCalls, 1);
    } finally {
      store.cleanup();
    }
  });

  it('drops malformed task status notifications without failing the task', async () => {
    const orchestrator = new TaskOrchestrator();
    const store = orchestrator;

    try {
      const notifications: unknown[] = [];
      const handler = orchestrator.wrapToolTask(
        async (_args: unknown, ctx: ToolCtx) => {
          await ctx.sendNotification?.({
            method: 'notifications/tasks/status',
            params: null,
          });

          return {
            content: [{ type: 'text', text: 'done' }],
            structuredContent: {},
          };
        },
        { toolName: 'test_tool', deps: stubDeps },
      );

      const baseCtx = createMockExtra(store);
      const ctx = {
        ...baseCtx,
        mcpReq: {
          ...baseCtx.mcpReq,
          notify: async (notification: unknown) => {
            notifications.push(notification);
          },
        },
      } as CreateTaskServerContext;
      const { task } = await handler.createTask(undefined as never, ctx);

      for (let i = 0; i < 10; i++) {
        const current = await store.getTask(task.taskId, 'test-session');
        if (current?.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 10));
      }

      const final = await store.getTask(task.taskId, 'test-session');
      assert.strictEqual(final?.status, 'completed');

      const result = await handler.getTaskResult(
        undefined as never,
        createMockTaskExtra(store, task.taskId),
      );
      assert.ok(result);
      assert.strictEqual(result?.content[0]?.type, 'text');
      assert.equal(notifications.length, 0);
    } finally {
      store.cleanup();
    }
  });

  it('uses tool progress context for initial task status message', async () => {
    const orchestrator = new TaskOrchestrator();
    const store = orchestrator;

    try {
      let releaseHandler: (() => void) | undefined;
      const blocked = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      const handler = orchestrator.wrapToolTask(
        async () => {
          await blocked;
          return {
            content: [{ type: 'text', text: 'done' }],
            structuredContent: {},
          };
        },
        {
          toolName: 'read',
          toolTitle: 'Read File',
          startStatusMessage: () => 'Read: README.md · head 20',
          deps: stubDeps,
        },
      );

      const { task } = await handler.createTask(undefined as never, createMockExtra(store));
      const midTask = await store.getTask(task.taskId, 'test-session');
      assert.strictEqual(midTask?.status, 'working');
      assert.strictEqual(midTask?.statusMessage, 'Read: README.md · head 20');

      releaseHandler?.();

      for (let i = 0; i < 10; i++) {
        const current = await store.getTask(task.taskId, 'test-session');
        if (current?.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 10));
      }

      const final = await store.getTask(task.taskId, 'test-session');
      assert.strictEqual(final?.status, 'completed');
    } finally {
      store.cleanup();
    }
  });

  it('ignores onProgress callback and does not update task status message', async () => {
    const orchestrator = new TaskOrchestrator();
    const store = orchestrator;

    try {
      const handler = orchestrator.wrapToolTask(
        async (_args: unknown, ctx: ToolCtx) => {
          // onProgress is intentionally a no-op in task orchestration context.
          if (ctx.onProgress) {
            ctx.onProgress({ current: 5, total: 10 });
          }
          return {
            content: [{ type: 'text', text: 'done' }],
            structuredContent: {},
          };
        },
        { toolName: 'test_tool', deps: stubDeps },
      );

      const baseCtx = createMockExtra(store);
      let statusUpdateCalls = 0;
      const originalUpdateTaskStatus = baseCtx.task.store.updateTaskStatus.bind(baseCtx.task.store);
      const ctx = {
        ...baseCtx,
        task: {
          ...baseCtx.task,
          store: {
            ...baseCtx.task.store,
            updateTaskStatus: async (
              taskId: string,
              status: Task['status'],
              statusMessage?: string,
            ) => {
              statusUpdateCalls++;
              await originalUpdateTaskStatus(taskId, status, statusMessage);
            },
          },
        },
      } as CreateTaskServerContext;
      const { task } = await handler.createTask(undefined as never, ctx);

      // Wait for task completion; onProgress should not affect task-store status messages.
      for (let i = 0; i < 20; i++) {
        const current = await store.getTask(task.taskId, 'test-session');
        if (current?.status === 'completed') {
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      const final = await store.getTask(task.taskId, 'test-session');
      assert.strictEqual(final?.status, 'completed');
      assert.equal(statusUpdateCalls, 1);
    } finally {
      store.cleanup();
    }
  });

  it('classifies a cancelled task by signal even when isError result omits the word "cancelled"', async () => {
    const orchestrator = new TaskOrchestrator();
    const store = orchestrator;

    try {
      const handler = orchestrator.wrapToolTask(
        async (_args: unknown, ctx: ToolCtx) => {
          // Wait for the abort signal, then return an isError result
          // whose text intentionally omits the word "cancelled".
          await new Promise<void>((resolve) => {
            if (ctx.signal?.aborted) {
              resolve();
              return;
            }
            ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return {
            content: [{ type: 'text' as const, text: 'UNKNOWN: operation halted' }],
            structuredContent: {},
            isError: true as const,
          };
        },
        { toolName: 'test_tool', deps: stubDeps },
      );

      const ctx = createMockExtra(orchestrator);
      const { task } = await handler.createTask(undefined as never, ctx);

      // Abort the orchestrator's internal AbortController for this task directly,
      // WITHOUT calling updateTaskStatus('cancelled'). This leaves the store status
      // as 'working' so that when the handler returns the isError result, the
      // result-path isCancelled check is the sole deciding factor for final status.
      // (If we called updateTaskStatus first, it would pre-set status to 'cancelled'
      // and storeTaskResult would throw, masking whether result-path handled it.)
      const internalControllers = (
        orchestrator as unknown as { controllers: Map<string, AbortController> }
      ).controllers;
      const ctrl = internalControllers.get(task.taskId);
      assert.ok(ctrl, 'expected an AbortController to exist for the task');
      ctrl.abort(new Error('UNKNOWN: operation halted'));

      // Wait for the task to terminate.
      let final: Task | undefined;
      for (let i = 0; i < 30; i++) {
        final = await store.getTask(task.taskId, 'test-session');
        if (final.status === 'cancelled' || final.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 10));
      }

      assert.strictEqual(
        final?.status,
        'cancelled',
        `expected cancelled, got ${final?.status ?? 'undefined'} — orchestrator must trust the signal, not the error text`,
      );
    } finally {
      store.cleanup();
    }
  });
});
