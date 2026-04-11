import {
  type CreateTaskServerContext,
  InMemoryTaskStore,
  RELATED_TASK_META_KEY,
  type RequestTaskStore,
  type Task,
  type TaskServerContext,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_TASK_TTL_MS,
  MAX_CONCURRENT_TASKS,
  MAX_TASK_TTL_MS,
} from '../../lib/constants.js';
import { ErrorCode } from '../../lib/errors.js';
import type { ToolResult } from '../../tools/shared.js';
import { createToolTaskHandler } from '../../tools/task-support.js';

/**
 * Build a minimal RequestTaskStore backed by InMemoryTaskStore.
 * InMemoryTaskStore.createTask requires (params, requestId, request, sessionId)
 * but RequestTaskStore.createTask only takes (params). We adapt by wrapping
 * the full-store calls with a fixed requestId and dummy request.
 */
function createTestTaskStore(): RequestTaskStore & { cleanup: () => void } {
  const store = new InMemoryTaskStore();
  let reqCounter = 0;

  return {
    async createTask(taskParams) {
      reqCounter++;
      const task = await store.createTask(
        taskParams,
        reqCounter,
        { method: 'tools/call', params: {} },
        'test-session'
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
      await store.updateTaskStatus(
        taskId,
        status as Task['status'],
        statusMessage,
        'test-session'
      );
    },
    async listTasks(cursor?) {
      return store.listTasks(cursor, 'test-session');
    },
    cleanup: () => store.cleanup(),
  };
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
    },
    sessionId: 'test-session',
    task: {
      store: taskStore,
    },
  } as unknown as CreateTaskServerContext;
}

function createMockTaskExtra(
  taskStore: RequestTaskStore,
  taskId: string
): TaskServerContext {
  return {
    ...createMockExtra(taskStore),
    task: {
      store: taskStore,
      id: taskId,
    },
  } as unknown as TaskServerContext;
}

describe('createToolTaskHandler', () => {
  it('createTask returns a task with valid shape', async () => {
    const store = createTestTaskStore();
    try {
      const handler = createToolTaskHandler(
        async () =>
          ({
            content: [{ type: 'text', text: 'done' }],
            structuredContent: { ok: true },
          }) as ToolResult<{ ok: boolean }>,
        { toolName: 'test_tool' }
      );

      const result = await handler.createTask(createMockExtra(store));
      assert.ok(result.task, 'createTask must return a task object');
      assert.equal(result.task.taskId.length > 0, true, 'taskId must be set');
      assert.ok(
        ['working', 'completed'].includes(result.task.status),
        `status must be working or completed, got: ${result.task.status}`
      );
      assert.equal(typeof result.task.createdAt, 'string');
      assert.equal(typeof result.task.lastUpdatedAt, 'string');
    } finally {
      store.cleanup();
    }
  });

  it('createTask sets initial statusMessage with tool name', async () => {
    const store = createTestTaskStore();
    try {
      // Use a slow handler so the task stays in 'working' long enough to check
      const handler = createToolTaskHandler(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return {
            content: [{ type: 'text', text: 'done' }],
          } as ToolResult<unknown>;
        },
        { toolName: 'my_grep' }
      );

      const { task } = await handler.createTask(createMockExtra(store));
      // Fetch the task immediately to see the statusMessage before completion
      const got = await handler.getTask(
        createMockTaskExtra(store, task.taskId)
      );
      assert.equal(got.statusMessage, 'my_grep: starting');
    } finally {
      store.cleanup();
    }
  });

  it('getTask returns normalized task state', async () => {
    const store = createTestTaskStore();
    try {
      const handler = createToolTaskHandler(
        async () =>
          ({
            content: [{ type: 'text', text: 'done' }],
            structuredContent: { ok: true },
          }) as ToolResult<{ ok: boolean }>
      );

      const { task } = await handler.createTask(createMockExtra(store));
      // Allow background execution to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      const got = await handler.getTask(
        createMockTaskExtra(store, task.taskId)
      );
      assert.equal(got.taskId, task.taskId);
      assert.ok(
        ['working', 'completed', 'failed'].includes(got.status),
        `unexpected status: ${got.status}`
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
      const handler = createToolTaskHandler(
        async () =>
          ({
            content: [{ type: 'text', text: 'hello' }],
            structuredContent: { ok: true },
          }) as ToolResult<{ ok: boolean }>
      );

      const { task } = await handler.createTask(createMockExtra(store));
      // Wait for background execution
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await handler.getTaskResult(
        createMockTaskExtra(store, task.taskId)
      );
      assert.ok(result.content, 'result must have content');
      assert.ok(Array.isArray(result.content), 'content must be an array');
    } finally {
      store.cleanup();
    }
  });

  it('error result projects to failed status', async () => {
    const store = createTestTaskStore();
    try {
      const handler = createToolTaskHandler(
        async () =>
          ({
            content: [{ type: 'text', text: 'UNKNOWN: boom' }],
            isError: true,
            errorCode: ErrorCode.UNKNOWN,
          }) as ToolResult<unknown>
      );

      const { task } = await handler.createTask(createMockExtra(store));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const got = await handler.getTask(
        createMockTaskExtra(store, task.taskId)
      );
      assert.equal(got.status, 'failed');
    } finally {
      store.cleanup();
    }
  });

  it('cancelled error code projects to cancelled status', async () => {
    const store = createTestTaskStore();
    try {
      const handler = createToolTaskHandler(
        async () =>
          ({
            content: [
              {
                type: 'text',
                text: `Error [${ErrorCode.CANCELLED}]: aborted`,
              },
            ],
            isError: true,
            errorCode: ErrorCode.CANCELLED,
          }) as ToolResult<unknown>
      );

      const { task } = await handler.createTask(createMockExtra(store));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const got = await handler.getTask(
        createMockTaskExtra(store, task.taskId)
      );
      assert.equal(got.status, 'cancelled');
    } finally {
      store.cleanup();
    }
  });

  it('applies default TTL when none is requested', async () => {
    const store = createTestTaskStore();
    try {
      const handler = createToolTaskHandler(
        async () =>
          ({
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: { ok: true },
          }) as ToolResult<{ ok: boolean }>
      );

      const { task } = await handler.createTask(createMockExtra(store));
      assert.equal(task.ttl, DEFAULT_TASK_TTL_MS);
    } finally {
      store.cleanup();
    }
  });

  it('clamps oversized TTL to MAX_TASK_TTL_MS', async () => {
    const store = createTestTaskStore();
    try {
      const handler = createToolTaskHandler(
        async () =>
          ({
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: { ok: true },
          }) as ToolResult<{ ok: boolean }>
      );

      const ctx = {
        ...createMockExtra(store),
        taskRequestedTtl: MAX_TASK_TTL_MS + 999_999,
      };
      const { task } = await handler.createTask(ctx);
      assert.ok(
        task.ttl !== null && task.ttl <= MAX_TASK_TTL_MS,
        `ttl ${String(task.ttl)} should be clamped to ${String(MAX_TASK_TTL_MS)}`
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
      const handler = createToolTaskHandler(
        async () =>
          ({
            content: [{ type: 'text', text: 'ok' }],
          }) as ToolResult<unknown>
      );

      await assert.rejects(
        async () => handler.createTask(createMockExtra(saturatedStore)),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(
            error.message.includes('Too many active tasks'),
            `Expected "Too many active tasks" in: ${error.message}`
          );
          return true;
        }
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
        const tasks = Array.from(
          { length: MAX_CONCURRENT_TASKS - 1 + createdCount },
          (_, i) => ({
            taskId: `fake-${String(i)}`,
            status: 'working' as const,
            ttl: null,
            createdAt: new Date().toISOString(),
            lastUpdatedAt: new Date().toISOString(),
          })
        );
        return { tasks };
      },
    };

    try {
      const handler = createToolTaskHandler(
        async () =>
          ({
            content: [{ type: 'text', text: 'ok' }],
          }) as ToolResult<unknown>
      );

      const firstTaskPromise = handler.createTask(
        createMockExtra(serializedStore)
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      const secondTaskPromise = handler.createTask(
        createMockExtra(serializedStore)
      );

      releaseFirstCreate();

      const firstTask = await firstTaskPromise;
      assert.ok(firstTask.task.taskId.length > 0);

      await assert.rejects(
        async () => secondTaskPromise,
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes('Too many active tasks'));
          return true;
        }
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

      const handler = createToolTaskHandler(
        async (_args: undefined, ctx: { signal?: AbortSignal }) => {
          // Simulate a long-running tool that respects the signal
          await new Promise<void>((resolve, reject) => {
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
        { cancelPollMs: 50 }
      );

      const { task } = await handler.createTask(createMockExtra(store));

      // Simulate SDK-side cancel: set task status to 'cancelled'
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
      const handler = createToolTaskHandler(
        async () =>
          ({
            content: [{ type: 'text', text: 'done' }],
            structuredContent: { ok: true },
          }) as ToolResult<{ ok: boolean }>
      );

      const { task } = await handler.createTask(createMockExtra(store));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await handler.getTaskResult(
        createMockTaskExtra(store, task.taskId)
      );
      const meta = result._meta as Record<string, unknown> | undefined;
      assert.ok(meta, 'result must include _meta');
      const related = meta[RELATED_TASK_META_KEY] as
        | Record<string, unknown>
        | undefined;
      assert.ok(related, `must have ${RELATED_TASK_META_KEY} key`);
      assert.equal(related['taskId'], task.taskId);
    } finally {
      store.cleanup();
    }
  });

  it('createTask returns model-immediate-response in _meta', async () => {
    const store = createTestTaskStore();
    try {
      const handler = createToolTaskHandler(
        async () =>
          ({
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: { ok: true },
          }) as ToolResult<{ ok: boolean }>,
        { toolName: 'grep' }
      );

      const result = await handler.createTask(createMockExtra(store));
      const meta = result._meta as Record<string, unknown> | undefined;
      assert.ok(meta, 'CreateTaskResult must include _meta');
      const immediate =
        meta['io.modelcontextprotocol/model-immediate-response'];
      assert.equal(
        typeof immediate,
        'string',
        'immediate response must be a string'
      );
      assert.ok(
        (immediate as string).includes('grep'),
        `immediate response should reference tool name, got: ${String(immediate)}`
      );
    } finally {
      store.cleanup();
    }
  });
});
