import {
  type CreateTaskServerContext,
  RELATED_TASK_META_KEY,
  type RequestTaskStore,
  type TaskServerContext,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode } from '../../src/core/errors.js';
import { MAX_CONCURRENT_TASKS, MAX_TASK_TTL_MS, TASK_TTL } from '../../src/core/util.js';
import { TASK_PROGRESS_STATUS_MESSAGE } from '../../src/tasks.js';
import { TaskOrchestrator } from '../../src/tasks.js';
import { EventedTaskStore } from '../../src/tasks.js';
import type { ToolResult } from '../../src/tools/_helpers.js';

/**
 * Build a minimal RequestTaskStore backed by InMemoryTaskStore.
 * InMemoryTaskStore.createTask requires (params, requestId, request, sessionId)
 * but RequestTaskStore.createTask only takes (params). We adapt by wrapping
 * the full-store calls with a fixed requestId and dummy request.
 */
function createTestTaskStore(): RequestTaskStore & {
  cleanup: () => void;
  orchestrator: TaskOrchestrator;
} {
  const store = new EventedTaskStore();
  const orchestrator = new TaskOrchestrator(store);
  let reqCounter = 0;

  return {
    async createTask(taskParams) {
      reqCounter++;
      const task = await store.createTask(
        taskParams,
        reqCounter,
        { method: 'tools/call', params: {} },
        'test-session',
      );
      return task;
    },
    async getTask(taskId) {
      const task = await store.getTask(taskId, 'test-session');
      if (!task) throw new Error(`Task not found: ${taskId}`);
      return task;
    },
    async storeTaskResult(taskId, status, result) {
      await store.storeTaskResult(taskId, status, result, 'test-session');
    },
    async getTaskResult(taskId) {
      return store.getTaskResult(taskId, 'test-session');
    },
    async updateTaskStatus(taskId, status, statusMessage?) {
      await store.updateTaskStatus(taskId, status, statusMessage, 'test-session');
    },
    async listTasks(cursor?) {
      return store.listTasks(cursor, 'test-session');
    },
    cleanup: () => store.cleanup(),
    orchestrator,
  };
}

function getHandler(
  store: { orchestrator: TaskOrchestrator },
  handler: Parameters<TaskOrchestrator['wrapToolTask']>[0],
  options: { toolName?: string } = {},
) {
  return store.orchestrator.wrapToolTask(handler, { toolName: options.toolName ?? 'test_tool' });
}

function callCreateTask(
  handler: ReturnType<TaskOrchestrator['wrapToolTask']>,
  ctx: CreateTaskServerContext,
) {
  return handler.createTask(undefined, ctx);
}
function callGetTask(
  handler: ReturnType<TaskOrchestrator['wrapToolTask']>,
  ctx: TaskServerContext,
) {
  return handler.getTask(undefined, ctx);
}
function callGetTaskResult(
  handler: ReturnType<TaskOrchestrator['wrapToolTask']>,
  ctx: TaskServerContext,
) {
  return handler.getTaskResult(undefined, ctx);
}

function createMockExtra(taskStore: RequestTaskStore): CreateTaskServerContext {
  const signal = new AbortController().signal;
  return {
    mcpReq: {
      id: 1,
      method: 'tools/call',
      signal,
      notify: async () => {},
      send: async () => ({}) as never,
      log: async () => {},
      elicitInput: async () => ({}) as never,
      requestSampling: async () => ({}) as never,
    },
    sessionId: 'test-session',
    task: {
      store: taskStore,
    },
  };
}

function createMockTaskExtra(taskStore: RequestTaskStore, taskId: string): TaskServerContext {
  return {
    ...createMockExtra(taskStore),
    task: {
      store: taskStore,
      id: taskId,
    },
  };
}

describe('createToolTaskHandler', () => {
  it('createTask returns a task with valid shape', async () => {
    const store = createTestTaskStore();
    try {
      const handler = getHandler(
        store,
        async () => ({
          content: [{ type: 'text', text: 'done' }],
          structuredContent: { ok: true },
        }),
        { toolName: 'test_tool' },
      );

      const result = await callCreateTask(handler, createMockExtra(store));
      assert.ok(result.task, 'createTask must return a task object');
      assert.equal(result.task.taskId.length > 0, true, 'taskId must be set');
      assert.ok(
        ['working', 'completed'].includes(result.task.status),
        `status must be working or completed, got: ${result.task.status}`,
      );
      assert.equal(typeof result.task.createdAt, 'string');
      assert.equal(typeof result.task.lastUpdatedAt, 'string');
    } finally {
      store.cleanup();
    }
  });

  it('createTask sets canonical working statusMessage', async () => {
    const store = createTestTaskStore();
    try {
      // Use a slow handler so the task stays in 'working' long enough to check
      const handler = getHandler(
        store,
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return {
            content: [{ type: 'text', text: 'done' }],
          } as ToolResult<unknown>;
        },
        { toolName: 'my_grep' },
      );

      const { task } = await callCreateTask(handler, createMockExtra(store));
      // Fetch the task immediately to verify canonical status message
      const got = await callGetTask(handler, createMockTaskExtra(store, task.taskId));
      assert.equal(got.statusMessage, TASK_PROGRESS_STATUS_MESSAGE);
    } finally {
      store.cleanup();
    }
  });

  it('getTask returns normalized task state', async () => {
    const store = createTestTaskStore();
    try {
      const handler = getHandler(store, async () => ({
        content: [{ type: 'text', text: 'done' }],
        structuredContent: { ok: true },
      }));

      const { task } = await callCreateTask(handler, createMockExtra(store));
      // Allow background execution to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      const got = await callGetTask(handler, createMockTaskExtra(store, task.taskId));
      assert.equal(got.taskId, task.taskId);
      assert.ok(
        ['working', 'completed', 'failed'].includes(got.status),
        `unexpected status: ${got.status}`,
      );
      assert.equal(typeof got.createdAt, 'string');
      assert.equal(typeof got.lastUpdatedAt, 'string');
    } finally {
      store.cleanup();
    }
  });

  it('getTaskResult returns CallToolResult after completion', async () => {
    const store = createTestTaskStore();
    try {
      const handler = getHandler(store, async () => ({
        content: [{ type: 'text', text: 'hello' }],
        structuredContent: { ok: true },
      }));

      const { task } = await callCreateTask(handler, createMockExtra(store));
      // Wait for background execution
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await callGetTaskResult(handler, createMockTaskExtra(store, task.taskId));
      assert.ok(result.content, 'result must have content');
      assert.ok(Array.isArray(result.content), 'content must be an array');
    } finally {
      store.cleanup();
    }
  });

  it('error result projects to failed status', async () => {
    const store = createTestTaskStore();
    try {
      const handler = getHandler(store, async () => ({
        content: [{ type: 'text', text: 'UNKNOWN: boom' }],
        isError: true,
        errorCode: ErrorCode.UNKNOWN,
      }));

      const { task } = await callCreateTask(handler, createMockExtra(store));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const got = await callGetTask(handler, createMockTaskExtra(store, task.taskId));
      assert.equal(got.status, 'failed');
    } finally {
      store.cleanup();
    }
  });

  it('cancelled error code projects to cancelled status', async () => {
    const store = createTestTaskStore();
    try {
      const handler = getHandler(store, async () => ({
        content: [
          {
            type: 'text',
            text: `Error [${ErrorCode.CANCELLED}]: aborted`,
          },
        ],
        isError: true,
        errorCode: ErrorCode.CANCELLED,
      }));

      const { task } = await callCreateTask(handler, createMockExtra(store));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const got = await callGetTask(handler, createMockTaskExtra(store, task.taskId));
      assert.equal(got.status, 'cancelled');
    } finally {
      store.cleanup();
    }
  });

  it('applies default TTL when none is requested', async () => {
    const store = createTestTaskStore();
    try {
      const handler = getHandler(store, async () => ({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { ok: true },
      }));

      const { task } = await callCreateTask(handler, createMockExtra(store));
      assert.equal(task.ttl, TASK_TTL);
    } finally {
      store.cleanup();
    }
  });

  it('clamps oversized TTL to MAX_TASK_TTL_MS', async () => {
    const store = createTestTaskStore();
    try {
      const handler = getHandler(store, async () => ({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { ok: true },
      }));

      const ctx = {
        ...createMockExtra(store),
        taskRequestedTtl: MAX_TASK_TTL_MS + 999_999,
      };
      const { task } = await callCreateTask(handler, ctx);
      assert.ok(
        task.ttl !== null && task.ttl <= MAX_TASK_TTL_MS,
        `ttl ${String(task.ttl)} should be clamped to ${String(MAX_TASK_TTL_MS)}`,
      );
    } finally {
      store.cleanup();
    }
  });

  it('rejects when concurrent task limit is reached', async () => {
    // Use a mock store whose listTasks always reports MAX_CONCURRENT_TASKS
    // active tasks, bypassing InMemoryTaskStore's PAGE_SIZE=10 pagination.
    const real = createTestTaskStore();
    const saturatedStore: RequestTaskStore = {
      createTask: real.createTask.bind(real),
      getTask: real.getTask.bind(real),
      storeTaskResult: real.storeTaskResult.bind(real),
      getTaskResult: real.getTaskResult.bind(real),
      updateTaskStatus: real.updateTaskStatus.bind(real),
      async listTasks() {
        const tasks = Array.from({ length: MAX_CONCURRENT_TASKS }, (_, i) => ({
          taskId: `fake-${String(i)}`,
          status: 'working' as const,
          ttl: null,
          createdAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
        }));
        return { tasks };
      },
    };
    try {
      const handler = getHandler(
        real,
        async () =>
          ({
            content: [{ type: 'text', text: 'ok' }],
          }) as ToolResult<unknown>,
      );

      await assert.rejects(
        async () => callCreateTask(handler, createMockExtra(saturatedStore)),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          if (error instanceof Error) {
            assert.ok(
              error.message.includes('Too many active tasks'),
              `Expected "Too many active tasks" in: ${error.message}`,
            );
          }

          return true;
        },
      );
    } finally {
      real.cleanup();
    }
  });

  it('serializes task creation so concurrent requests cannot bypass the active-task limit', async () => {
    const real = createTestTaskStore();
    let createdCount = 0;
    let createCalls = 0;
    let releaseFirstCreate!: () => void;
    const firstCreateGate = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve;
    });

    const serializedStore: RequestTaskStore = {
      async createTask(taskParams) {
        createCalls++;
        if (createCalls === 1) {
          await firstCreateGate;
        }
        createdCount++;
        return real.createTask(taskParams);
      },
      getTask: real.getTask.bind(real),
      storeTaskResult: real.storeTaskResult.bind(real),
      getTaskResult: real.getTaskResult.bind(real),
      updateTaskStatus: real.updateTaskStatus.bind(real),
      async listTasks() {
        const tasks = Array.from({ length: MAX_CONCURRENT_TASKS - 1 + createdCount }, (_, i) => ({
          taskId: `fake-${String(i)}`,
          status: 'working' as const,
          ttl: null,
          createdAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
        }));
        return { tasks };
      },
    };

    try {
      const handler = getHandler(
        real,
        async () =>
          ({
            content: [{ type: 'text', text: 'ok' }],
          }) as ToolResult<unknown>,
      );

      const firstTaskPromise = callCreateTask(handler, createMockExtra(serializedStore));
      await new Promise((resolve) => setTimeout(resolve, 10));

      const secondTaskPromise = callCreateTask(handler, createMockExtra(serializedStore));

      releaseFirstCreate();

      const firstTask = await firstTaskPromise;
      assert.ok(firstTask.task.taskId.length > 0);

      await assert.rejects(
        async () => secondTaskPromise,
        (error: unknown) => {
          assert.ok(error instanceof Error);
          if (error instanceof Error) {
            assert.ok(error.message.includes('Too many active tasks'));
          }

          return true;
        },
      );
      assert.equal(createCalls, 1);
    } finally {
      real.cleanup();
    }
  });

  it('propagates cancellation signal to running tool', async () => {
    const store = createTestTaskStore();
    try {
      let signalAborted = false;

      const handler = getHandler(
        store,
        async (_args: undefined, ctx: { signal?: AbortSignal }) => {
          // Simulate a long-running tool that respects the signal
          await new Promise<void>((resolve, reject) => {
            if (ctx.signal?.aborted) {
              console.log('SETTING SIGNAL ABORTED');
              signalAborted = true;
              return reject(ctx.signal.reason as Error);
            }
            const timer = setTimeout(resolve, 10_000);
            ctx.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              signalAborted = true;
              reject(ctx.signal?.reason as Error);
            });
          });
          return {
            content: [{ type: 'text', text: 'done' }],
          } as ToolResult<unknown>;
        },
        { cancelPollMs: 50 },
      );

      const { task } = await callCreateTask(handler, createMockExtra(store));

      // Simulate SDK-side cancel: set task status to 'cancelled'
      console.log('ABOUT TO CANCEL', task.taskId);
      await new Promise((r) => setTimeout(r, 20));
      await store.updateTaskStatus(task.taskId, 'cancelled');

      // Wait for the cancel poller to detect the change (poll interval + margin)
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.equal(signalAborted, true, 'signal must be aborted after cancel');
    } finally {
      store.cleanup();
    }
  });

  it('getTaskResult attaches io.modelcontextprotocol/related-task metadata', async () => {
    const store = createTestTaskStore();
    try {
      const handler = getHandler(store, async () => ({
        content: [{ type: 'text', text: 'done' }],
        structuredContent: { ok: true },
      }));

      const { task } = await callCreateTask(handler, createMockExtra(store));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await callGetTaskResult(handler, createMockTaskExtra(store, task.taskId));
      const meta = result._meta as Record<string, unknown> | undefined;
      assert.ok(meta, 'result must include _meta');
      const related = meta[RELATED_TASK_META_KEY] as Record<string, unknown> | undefined;
      assert.ok(related, `must have ${RELATED_TASK_META_KEY} key`);
      assert.equal(related['taskId'], task.taskId);
    } finally {
      store.cleanup();
    }
  });

  it('createTask does not include non-standard _meta keys', async () => {
    const store = createTestTaskStore();
    try {
      const handler = getHandler(
        store,
        async () => ({
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: { ok: true },
        }),
        { toolName: 'search_text' },
      );

      const result = await callCreateTask(handler, createMockExtra(store));
      const meta = result._meta as Record<string, unknown> | undefined;
      if (meta) {
        assert.equal(
          meta['io.modelcontextprotocol/model-immediate-response'],
          undefined,
          '_meta must not contain non-standard model-immediate-response key',
        );
      }
    } finally {
      store.cleanup();
    }
  });

  it('stores cancelled as failed in task store (SDK compatibility)', async () => {
    // The SDK task store only knows 'completed'/'failed'. CANCELLED is stored
    // as 'failed' but re-mapped to 'cancelled' on reads via our normalizer.
    const store = createTestTaskStore();
    try {
      const handler = getHandler(store, () =>
        Promise.resolve({
          content: [{ type: 'text', text: 'CANCELLED: aborted' }],
          isError: true as const,
          errorCode: ErrorCode.CANCELLED,
        }),
      );

      const { task } = await callCreateTask(handler, createMockExtra(store));
      // Wait for background execution to complete
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const current = await callGetTask(handler, createMockTaskExtra(store, task.taskId));
        if (current.status === 'cancelled') break;
      }

      const got = await callGetTask(handler, createMockTaskExtra(store, task.taskId));
      assert.equal(got.status, 'cancelled');
      // cancelled tasks do not have results in standard SDK store
    } finally {
      store.cleanup();
    }
  });

  it('attaches RELATED_TASK_META_KEY to task result on failure', async () => {
    const store = createTestTaskStore();
    try {
      const handler = getHandler(store, () =>
        Promise.resolve({
          content: [{ type: 'text', text: 'NOT_FOUND: missing' }],
          isError: true as const,
          errorCode: ErrorCode.NOT_FOUND,
        }),
      );

      const { task } = await callCreateTask(handler, createMockExtra(store));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const taskExtra = createMockTaskExtra(store, task.taskId);
      const got = await callGetTask(handler, taskExtra);
      assert.equal(got.status, 'failed');

      const result = await callGetTaskResult(handler, taskExtra);
      assert.equal(result.isError, true);
      assert.deepEqual(result._meta, {
        [RELATED_TASK_META_KEY]: { taskId: task.taskId },
      });
    } finally {
      store.cleanup();
    }
  });
});
