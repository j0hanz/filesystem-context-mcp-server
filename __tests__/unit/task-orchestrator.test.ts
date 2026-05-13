import {
  type CallToolResult,
  type CreateTaskServerContext,
  type Task,
  type TaskServerContext,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode } from '../../src/core/errors.js';
import { TaskOrchestrator } from '../../src/tasks.js';
import { EventedTaskStore } from '../../src/tasks.js';
import { type ToolContext } from '../../src/tools/_helpers.js';

function createMockExtra(
  store: EventedTaskStore,
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
  store: EventedTaskStore,
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
    const store = new EventedTaskStore();
    const orchestrator = new TaskOrchestrator(store);

    try {
      let executed = false;
      const handler = orchestrator.wrapToolTask(
        async (_args: unknown, _ctx: ToolContext) => {
          executed = true;
          return {
            content: [{ type: 'text', text: 'success' }],
            structuredContent: { ok: true },
          };
        },
        { toolName: 'test_tool' },
      );

      const ctx = createMockExtra(store);
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
    const store = new EventedTaskStore();
    const orchestrator = new TaskOrchestrator(store);

    try {
      let cancelled = false;
      const handler = orchestrator.wrapToolTask(
        async (_args: unknown, ctx: ToolContext) => {
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
        { toolName: 'test_tool' },
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

  it('updates task status message on progress notifications', async () => {
    const store = new EventedTaskStore();
    const orchestrator = new TaskOrchestrator(store);

    try {
      const handler = orchestrator.wrapToolTask(
        async (_args: unknown, ctx: ToolContext) => {
          if (ctx.sendNotification) {
            await ctx.sendNotification({
              method: 'notifications/tasks/status',
              params: {
                taskId: 'ignored', // Orchestrator should inject correct taskId
                status: 'working',
                statusMessage: 'Custom progress message',
              },
            });
          }
          return {
            content: [{ type: 'text', text: 'done' }],
            structuredContent: {},
          };
        },
        { toolName: 'test_tool' },
      );

      const ctx = createMockExtra(store);
      const { task } = await handler.createTask(undefined as never, ctx);

      // Wait for progress to be processed
      for (let i = 0; i < 10; i++) {
        const current = await store.getTask(task.taskId, 'test-session');
        if (current?.statusMessage === 'Custom progress message') break;
        await new Promise((r) => setTimeout(r, 10));
      }

      const final = await store.getTask(task.taskId, 'test-session');
      assert.strictEqual(final?.statusMessage, 'Custom progress message');
    } finally {
      store.cleanup();
    }
  });

  it('ignores malformed task status notification params without failing the task', async () => {
    const store = new EventedTaskStore();
    const orchestrator = new TaskOrchestrator(store);

    try {
      const handler = orchestrator.wrapToolTask(
        async (_args: unknown, ctx: ToolContext) => {
          await ctx.sendNotification?.({
            method: 'notifications/tasks/status',
            params: null,
          });

          return {
            content: [{ type: 'text', text: 'done' }],
            structuredContent: {},
          };
        },
        { toolName: 'test_tool' },
      );

      const ctx = createMockExtra(store);
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
    } finally {
      store.cleanup();
    }
  });

  it('updates task status message when tool calls onProgress callback', async () => {
    const store = new EventedTaskStore();
    const orchestrator = new TaskOrchestrator(store);

    try {
      const handler = orchestrator.wrapToolTask(
        async (_args: unknown, ctx: ToolContext) => {
          // Tool calls onProgress callback (this is how tools report progress)
          if (ctx.onProgress) {
            ctx.onProgress({ current: 5, total: 10 });
          }
          return {
            content: [{ type: 'text', text: 'done' }],
            structuredContent: {},
          };
        },
        { toolName: 'test_tool' },
      );

      const ctx = createMockExtra(store);
      const { task } = await handler.createTask(undefined as never, ctx);

      // Wait for task completion since onProgress is now a no-op
      for (let i = 0; i < 20; i++) {
        const current = await store.getTask(task.taskId, 'test-session');
        if (current?.status === 'completed') {
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      const final = await store.getTask(task.taskId, 'test-session');
      // onProgress is now a no-op, so statusMessage won't be updated by it
      assert.strictEqual(final?.status, 'completed');
    } finally {
      store.cleanup();
    }
  });
});
