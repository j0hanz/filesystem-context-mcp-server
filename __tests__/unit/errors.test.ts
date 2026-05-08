import {
  type CreateTaskServerContext,
  type GetTaskResult,
  RELATED_TASK_META_KEY,
  type RequestTaskStore,
  type Result,
  type TaskServerContext,
  type TaskStatusNotificationParams,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  MAX_CONCURRENT_TASKS,
  MAX_TASK_TTL_MS,
} from '../../src/lib/constants.js';
import {
  ErrorCode,
  getSuggestion,
  isNodeError,
  McpError,
} from '../../src/lib/errors.js';
import { createToolTaskHandler } from '../../src/tools/tool-execution.js';

// ─── isNodeError ────────────────────────────────────────────────────────────

describe('isNodeError', () => {
  it('returns true for system errors with a string code', () => {
    let err: NodeJS.ErrnoException | undefined;
    try {
      readdirSync(`/nonexistent-path-that-cannot-exist-${Date.now()}`);
    } catch (e: unknown) {
      err = e as NodeJS.ErrnoException;
    }
    assert.ok(err !== undefined, 'Should have thrown');
    assert.equal(isNodeError(err), true);
  });

  it('returns false for plain Error with no code', () => {
    assert.equal(isNodeError(new Error('plain')), false);
  });

  it('returns false for plain Error with numeric code', () => {
    const e = Object.assign(new Error('numeric'), { code: 42 });
    assert.equal(isNodeError(e), false);
  });

  it('returns false for non-Error primitives', () => {
    assert.equal(isNodeError('not an error'), false);
    assert.equal(isNodeError(null), false);
    assert.equal(isNodeError(undefined), false);
    assert.equal(isNodeError({}), false);
  });
});

// ─── McpError ───────────────────────────────────────────────────────────────

describe('McpError', () => {
  it('stores code, message, and is instanceof Error', () => {
    const err = new McpError(ErrorCode.NOT_FOUND, 'file not found');
    assert.equal(err.code, ErrorCode.NOT_FOUND);
    assert.equal(err.message, 'file not found');
    assert.ok(err instanceof Error);
  });

  it('has name "McpError"', () => {
    const err = new McpError(ErrorCode.PERMISSION_DENIED, 'no access');
    assert.equal(err.name, 'McpError');
  });

  it('stores optional path', () => {
    const err = new McpError(ErrorCode.NOT_FOUND, 'msg', '/some/path');
    assert.equal(err.path, '/some/path');
  });

  it('stores no path when not provided', () => {
    const err = new McpError(ErrorCode.NOT_FOUND, 'msg');
    assert.equal(err.path, undefined);
  });
});

// ─── getSuggestion ──────────────────────────────────────────────────────────

describe('getSuggestion', () => {
  it('returns a string or undefined for every ErrorCode value', () => {
    const withSuggestion: string[] = [];
    const withoutSuggestion: string[] = [];
    for (const code of Object.values(ErrorCode)) {
      const suggestion = getSuggestion(code);
      if (suggestion !== undefined) {
        assert.equal(typeof suggestion, 'string');
        assert.ok(
          suggestion.length > 0,
          `Expected non-empty suggestion for ${code}`
        );
        withSuggestion.push(code);
      } else {
        withoutSuggestion.push(code);
      }
    }
    assert.ok(
      withSuggestion.length > 0,
      'At least some codes should have suggestions'
    );
  });
});

function createMockTaskStore(): {
  taskStore: RequestTaskStore;
  getStoredTask: () => GetTaskResult | undefined;
  getStoredResult: () => Result | undefined;
} {
  let storedTask: GetTaskResult | undefined;
  let storedResult: Result | undefined;
  let taskCounter = 0;

  const taskStore: RequestTaskStore = {
    createTask(taskParams) {
      taskCounter += 1;
      const createdAt = new Date().toISOString();
      storedTask = {
        taskId: `task-${taskCounter}`,
        status: 'working',
        ttl: taskParams.ttl ?? null,
        createdAt,
        lastUpdatedAt: createdAt,
        pollInterval: taskParams.pollInterval ?? 1000,
      };
      return Promise.resolve(storedTask);
    },
    getTask(taskId) {
      assert.equal(storedTask?.taskId, taskId);
      assert.ok(storedTask, 'Expected task to exist');
      return Promise.resolve({ ...storedTask });
    },
    storeTaskResult(taskId, status, result) {
      assert.equal(storedTask?.taskId, taskId);
      assert.ok(storedTask, 'Expected task to exist before storing result');
      storedResult = result;
      storedTask = {
        ...storedTask,
        status,
        lastUpdatedAt: new Date().toISOString(),
      };
      return Promise.resolve();
    },
    getTaskResult(taskId) {
      assert.equal(storedTask?.taskId, taskId);
      assert.ok(storedResult, 'Expected stored result to exist');
      return Promise.resolve(storedResult);
    },
    updateTaskStatus(taskId, status, statusMessage) {
      assert.equal(storedTask?.taskId, taskId);
      assert.ok(storedTask, 'Expected task to exist before updating status');
      storedTask = {
        ...storedTask,
        status,
        ...(statusMessage ? { statusMessage } : {}),
        lastUpdatedAt: new Date().toISOString(),
      };
      return Promise.resolve();
    },
    listTasks() {
      return Promise.resolve({ tasks: storedTask ? [{ ...storedTask }] : [] });
    },
  };

  return {
    taskStore,
    getStoredTask: () => storedTask,
    getStoredResult: () => storedResult,
  };
}

function createCreateTaskContext(
  taskStore: RequestTaskStore,
  notifications: TaskStatusNotificationParams[] = [],
  requestedTtl?: number
): CreateTaskServerContext {
  const signal = new AbortController().signal;
  return {
    mcpReq: {
      id: 1,
      method: 'tools/call',
      signal,
      notify: async (notification: { method: string; params?: unknown }) => {
        if (notification.method === 'notifications/tasks/status') {
          notifications.push(
            notification.params as TaskStatusNotificationParams
          );
        }
      },
      send: async () => ({}) as never,
    },
    sessionId: 'test-session',
    task: {
      store: taskStore,
      ...(requestedTtl !== undefined ? { requestedTtl } : {}),
    },
  } as unknown as CreateTaskServerContext;
}

function createTaskContext(
  taskStore: RequestTaskStore,
  taskId: string
): TaskServerContext {
  return {
    ...createCreateTaskContext(taskStore),
    task: {
      store: taskStore,
      id: taskId,
    },
  };
}

describe('task cancellation normalization', () => {
  it('reports cancelled while storing failed for SDK task-store compatibility', async () => {
    const notifications: TaskStatusNotificationParams[] = [];
    const { taskStore, getStoredResult, getStoredTask } = createMockTaskStore();
    const handler = createToolTaskHandler(() =>
      Promise.resolve({
        content: [{ type: 'text', text: 'CANCELLED: cancelled' }],
        isError: true as const,
        errorCode: ErrorCode.CANCELLED,
      })
    );

    const createExtra = createCreateTaskContext(taskStore, notifications);

    const { task } = await handler.createTask(createExtra);

    for (
      let attempt = 0;
      attempt < 20 &&
      (!getStoredResult() ||
        !notifications.some(
          (notification) => notification.status === 'cancelled'
        ));
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    assert.equal(getStoredTask()?.status, 'failed');
    assert.ok(
      notifications.some((notification) => notification.status === 'cancelled'),
      `Expected a cancelled notification, got ${JSON.stringify(notifications)}`
    );

    const taskExtra = createTaskContext(taskStore, task.taskId);
    const reportedTask = await handler.getTask(taskExtra);

    assert.equal(reportedTask.status, 'cancelled');
    assert.equal((await handler.getTaskResult(taskExtra)).isError, true);
  });
});

describe('task failure normalization', () => {
  it('reports tool errors as failed and attaches related-task metadata', async () => {
    const { taskStore, getStoredTask } = createMockTaskStore();
    const handler = createToolTaskHandler(() =>
      Promise.resolve({
        content: [{ type: 'text', text: 'NOT_FOUND: missing file' }],
        isError: true as const,
        errorCode: ErrorCode.NOT_FOUND,
      })
    );

    const { task } = await handler.createTask(
      createCreateTaskContext(taskStore)
    );

    for (
      let attempt = 0;
      attempt < 20 && getStoredTask()?.status !== 'failed';
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const taskExtra = createTaskContext(taskStore, task.taskId);

    const reportedTask = await handler.getTask(taskExtra);
    assert.equal(reportedTask.status, 'failed');

    const result = await handler.getTaskResult(taskExtra);
    assert.equal(result.isError, true);
    assert.deepEqual(result._meta, {
      [RELATED_TASK_META_KEY]: { taskId: task.taskId },
    });
  });

  it('clamps requested task ttl to the server maximum', async () => {
    const { taskStore } = createMockTaskStore();
    const handler = createToolTaskHandler(() =>
      Promise.resolve({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: {},
      })
    );

    const { task } = await handler.createTask(
      createCreateTaskContext(taskStore, [], MAX_TASK_TTL_MS + 60_000)
    );

    assert.equal(task.ttl, MAX_TASK_TTL_MS);
  });

  it('rejects task creation when the active-task limit is reached', async () => {
    const tasks = Array.from({ length: MAX_CONCURRENT_TASKS }, (_, index) => ({
      taskId: `task-${index}`,
      status: 'working' as const,
      ttl: 1_000,
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    }));
    const taskStore = {
      createTask() {
        assert.fail('createTask should not be called when the limit is hit');
      },
      getTask() {
        assert.fail('getTask should not be called in this test');
      },
      storeTaskResult() {
        assert.fail('storeTaskResult should not be called in this test');
      },
      getTaskResult() {
        assert.fail('getTaskResult should not be called in this test');
      },
      updateTaskStatus() {
        assert.fail('updateTaskStatus should not be called in this test');
      },
      listTasks() {
        return Promise.resolve({ tasks });
      },
    } satisfies RequestTaskStore;
    const handler = createToolTaskHandler(() =>
      Promise.resolve({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: {},
      })
    );

    await assert.rejects(async () => {
      await handler.createTask(createCreateTaskContext(taskStore));
    }, /Too many active tasks/u);
  });
});
