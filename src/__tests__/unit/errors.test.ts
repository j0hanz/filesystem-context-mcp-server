import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import type {
  CreateTaskRequestHandlerExtra,
  TaskRequestHandlerExtra,
} from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import type { RequestTaskStore } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  GetTaskResult,
  Result,
  TaskStatusNotificationParams,
} from '@modelcontextprotocol/sdk/types.js';

import { MAX_CONCURRENT_TASKS, MAX_TASK_TTL_MS } from '../../lib/constants.js';
import {
  ErrorCode,
  getSuggestion,
  isNodeError,
  McpError,
} from '../../lib/errors.js';
import { createToolTaskHandler } from '../../tools/task-support.js';

// ─── isNodeError ────────────────────────────────────────────────────────────

describe('isNodeError', () => {
  it('returns true for system errors with a string code', () => {
    let err: NodeJS.ErrnoException | undefined;
    try {
      readdirSync('/nonexistent-path-that-cannot-exist-' + Date.now());
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
    const err = new McpError(ErrorCode.E_NOT_FOUND, 'file not found');
    assert.equal(err.code, ErrorCode.E_NOT_FOUND);
    assert.equal(err.message, 'file not found');
    assert.ok(err instanceof Error);
  });

  it('has name "McpError"', () => {
    const err = new McpError(ErrorCode.E_PERMISSION_DENIED, 'no access');
    assert.equal(err.name, 'McpError');
  });

  it('stores optional path', () => {
    const err = new McpError(ErrorCode.E_NOT_FOUND, 'msg', '/some/path');
    assert.equal(err.path, '/some/path');
  });

  it('stores no path when not provided', () => {
    const err = new McpError(ErrorCode.E_NOT_FOUND, 'msg');
    assert.equal(err.path, undefined);
  });
});

// ─── getSuggestion ──────────────────────────────────────────────────────────

describe('getSuggestion', () => {
  it('returns a non-empty string for every ErrorCode value', () => {
    for (const code of Object.values(ErrorCode)) {
      const suggestion = getSuggestion(code);
      assert.equal(typeof suggestion, 'string');
      assert.ok(
        suggestion.length > 0,
        `Expected non-empty suggestion for ${code}`
      );
    }
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

describe('task cancellation normalization', () => {
  it('reports cancelled while storing failed for SDK task-store compatibility', async () => {
    const notifications: TaskStatusNotificationParams[] = [];
    const { taskStore, getStoredResult, getStoredTask } = createMockTaskStore();
    const handler = createToolTaskHandler(() =>
      Promise.resolve({
        content: [{ type: 'text', text: 'Error [E_CANCELLED]: cancelled' }],
        isError: true as const,
        errorCode: ErrorCode.E_CANCELLED,
      })
    );

    const createExtra = {
      taskStore,
      sendNotification: (notification: {
        method: 'notifications/tasks/status';
        params: TaskStatusNotificationParams;
      }) => {
        notifications.push(notification.params);
        return Promise.resolve();
      },
    } as unknown as CreateTaskRequestHandlerExtra;

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

    const taskExtra = {
      taskId: task.taskId,
      taskStore,
    } as unknown as TaskRequestHandlerExtra;
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
        content: [{ type: 'text', text: 'Error [E_NOT_FOUND]: missing file' }],
        isError: true as const,
        errorCode: ErrorCode.E_NOT_FOUND,
      })
    );

    const { task } = await handler.createTask({
      taskStore,
    } as unknown as CreateTaskRequestHandlerExtra);

    for (
      let attempt = 0;
      attempt < 20 && getStoredTask()?.status !== 'failed';
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const taskExtra = {
      taskId: task.taskId,
      taskStore,
    } as unknown as TaskRequestHandlerExtra;

    const reportedTask = await handler.getTask(taskExtra);
    assert.equal(reportedTask.status, 'failed');

    const result = await handler.getTaskResult(taskExtra);
    assert.equal(result.isError, true);
    assert.deepEqual(result._meta, {
      'io.modelcontextprotocol/related-task': { taskId: task.taskId },
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

    const { task } = await handler.createTask({
      taskStore,
      taskRequestedTtl: MAX_TASK_TTL_MS + 60_000,
    } as unknown as CreateTaskRequestHandlerExtra);

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
      await handler.createTask({
        taskStore,
      } as unknown as CreateTaskRequestHandlerExtra);
    }, /Too many active tasks/u);
  });
});
