import assert from 'node:assert/strict';
import { it } from 'node:test';

import type {
  CreateTaskRequestHandlerExtra,
  TaskRequestHandlerExtra,
} from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import type { RequestTaskStore } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Result } from '@modelcontextprotocol/sdk/types.js';

import { ErrorCode } from '../../lib/errors.js';
import { createToolTaskHandler } from '../../tools/task-support.js';

interface TaskState {
  status: string;
  result?: Result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(5);
  }
  assert.fail('Timed out waiting for task completion');
}

function createInMemoryTaskStore(): {
  taskStore: RequestTaskStore;
  tasks: Map<string, TaskState>;
} {
  const tasks = new Map<string, TaskState>();
  let nextId = 1;

  const taskStore = {
    createTask: async () => {
      const taskId = `task-${String(nextId++)}`;
      tasks.set(taskId, { status: 'working' });
      return { taskId, status: 'working' };
    },
    getTask: async (taskId: string) => {
      const task = tasks.get(taskId);
      if (!task) {
        throw new Error('task not found');
      }
      return { taskId, status: task.status };
    },
    storeTaskResult: async (
      taskId: string,
      status: 'completed' | 'failed',
      result: Result
    ) => {
      const task = tasks.get(taskId);
      if (!task) {
        throw new Error('task not found');
      }
      if (task.status === 'completed' || task.status === 'failed') {
        throw new Error('task has terminal status');
      }
      task.status = status;
      task.result = result;
    },
    getTaskResult: async (taskId: string) => {
      const task = tasks.get(taskId);
      if (!task || !task.result) {
        throw new Error('task result not found');
      }
      return task.result;
    },
  } as unknown as RequestTaskStore;

  return { taskStore, tasks };
}

function createRequestExtra(
  taskStore: RequestTaskStore
): CreateTaskRequestHandlerExtra {
  return {
    signal: new AbortController().signal,
    requestId: 'request-id',
    sendNotification: async () => {},
    sendRequest: async () => {
      throw new Error('sendRequest is not used in this test');
    },
    taskStore,
  };
}

function createTaskRequestExtra(
  taskStore: RequestTaskStore,
  taskId: string
): TaskRequestHandlerExtra {
  return {
    ...createRequestExtra(taskStore),
    taskId,
  };
}

await it('stores completed background task results', async () => {
  const { taskStore, tasks } = createInMemoryTaskStore();

  const handler = createToolTaskHandler(async () => {
    return {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { ok: true },
    };
  });

  const createResult = await handler.createTask(createRequestExtra(taskStore));
  const taskId = createResult.task.taskId;

  await waitFor(() => tasks.get(taskId)?.status === 'completed');

  const taskResult = await handler.getTaskResult(
    createTaskRequestExtra(taskStore, taskId)
  );
  assert.strictEqual(taskResult.isError, undefined);
  assert.deepStrictEqual(
    taskResult._meta?.['io.modelcontextprotocol/related-task'],
    {
      taskId,
    }
  );
});

await it('publishes optional tasks/status notifications when sender is available', async () => {
  const { taskStore, tasks } = createInMemoryTaskStore();
  const notifications: Array<{ method?: unknown; params?: unknown }> = [];

  const handler = createToolTaskHandler(async () => {
    return {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { ok: true },
    };
  });

  const createResult = await handler.createTask({
    ...createRequestExtra(taskStore),
    sendNotification: async (notification) => {
      notifications.push(
        notification as { method?: unknown; params?: unknown }
      );
    },
  });
  const taskId = createResult.task.taskId;

  await waitFor(() => tasks.get(taskId)?.status === 'completed');
  await waitFor(() =>
    notifications.some((notification) => {
      if (notification.method !== 'notifications/tasks/status') return false;
      const params = notification.params as {
        taskId?: string;
        status?: string;
      };
      return params.taskId === taskId && params.status === 'completed';
    })
  );
});

await it('does not emit unhandled rejections when result storage races terminal task status', async () => {
  const tasks = new Map<string, TaskState>();
  let storeAttempts = 0;

  const taskStore = {
    createTask: async () => {
      const taskId = 'task-race';
      tasks.set(taskId, { status: 'working' });
      return { taskId, status: 'working' };
    },
    getTask: async (taskId: string) => {
      const task = tasks.get(taskId);
      if (!task) {
        throw new Error('task not found');
      }
      return { taskId, status: task.status };
    },
    storeTaskResult: async (
      taskId: string,
      _status: 'completed' | 'failed',
      _result: Result
    ) => {
      const task = tasks.get(taskId);
      if (!task) {
        throw new Error('task not found');
      }
      storeAttempts += 1;
      task.status = 'cancelled';
      throw new Error('task has terminal status cancelled');
    },
    getTaskResult: async () => {
      throw new Error('not used');
    },
  } as unknown as RequestTaskStore;

  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };

  process.on('unhandledRejection', onUnhandledRejection);
  try {
    const handler = createToolTaskHandler(async () => {
      return {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { ok: true },
      };
    });

    await handler.createTask(createRequestExtra(taskStore));
    await sleep(50);

    assert.strictEqual(storeAttempts, 1);
    assert.strictEqual(tasks.get('task-race')?.status, 'cancelled');
    assert.strictEqual(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

await it('projects failed E_CANCELLED task results to cancelled status on getTask', async () => {
  const { taskStore, tasks } = createInMemoryTaskStore();

  const handler = createToolTaskHandler(async () => {
    return {
      content: [
        { type: 'text', text: 'Error [E_CANCELLED]: Operation cancelled' },
      ],
      isError: true,
    };
  });

  const createResult = await handler.createTask(createRequestExtra(taskStore));
  const taskId = createResult.task.taskId;

  await waitFor(() => tasks.get(taskId)?.status === 'failed');

  const task = await handler.getTask(createTaskRequestExtra(taskStore, taskId));
  assert.strictEqual(task.status, 'cancelled');
});

await it('emits cancelled tasks/status notifications for E_CANCELLED task results', async () => {
  const { taskStore } = createInMemoryTaskStore();
  const notifications: Array<{ method?: unknown; params?: unknown }> = [];

  const handler = createToolTaskHandler(async () => {
    return {
      content: [
        { type: 'text', text: 'Error [E_CANCELLED]: Operation cancelled' },
      ],
      isError: true,
    };
  });

  await handler.createTask({
    ...createRequestExtra(taskStore),
    sendNotification: async (notification) => {
      notifications.push(
        notification as { method?: unknown; params?: unknown }
      );
    },
  });

  await waitFor(() =>
    notifications.some((notification) => {
      if (notification.method !== 'notifications/tasks/status') return false;
      const params = notification.params as { status?: string };
      return params.status === 'cancelled';
    })
  );
});

await it('stores non-cancelled tool error results as completed so clients retrieve the actual error', async () => {
  const { taskStore, tasks } = createInMemoryTaskStore();

  const handler = createToolTaskHandler(async () => {
    return {
      content: [{ type: 'text', text: 'Error [E_NOT_FOUND]: file not found' }],
      structuredContent: {
        ok: false,
        error: { code: 'E_NOT_FOUND', message: 'file not found' },
      },
      isError: true,
    };
  });

  const createResult = await handler.createTask(createRequestExtra(taskStore));
  const taskId = createResult.task.taskId;

  // Task must be 'completed' (not 'failed') so the client can call getTaskResult
  // and receive the actual error instead of the generic "Task X failed: unknown error".
  await waitFor(() => tasks.get(taskId)?.status === 'completed');

  const taskResult = await handler.getTaskResult(
    createTaskRequestExtra(taskStore, taskId)
  );
  assert.strictEqual(taskResult.isError, true);
  const firstContent = (
    taskResult.content as Array<{ type?: string; text?: string }>
  )[0];
  assert.strictEqual(firstContent?.text, 'Error [E_NOT_FOUND]: file not found');
});

await it('strips structuredContent from non-cancelled error task results to prevent output-schema validation failures', async () => {
  const { taskStore, tasks } = createInMemoryTaskStore();

  const handler = createToolTaskHandler(async () => {
    return {
      content: [{ type: 'text', text: 'Error [E_NOT_FOUND]: file not found' }],
      structuredContent: {
        ok: false,
        error: { code: 'E_NOT_FOUND', message: 'file not found' },
      },
      isError: true,
    };
  });

  const createResult = await handler.createTask(createRequestExtra(taskStore));
  const taskId = createResult.task.taskId;

  await waitFor(() => tasks.get(taskId)?.status === 'completed');

  const taskResult = await handler.getTaskResult(
    createTaskRequestExtra(taskStore, taskId)
  );
  // structuredContent must be absent: clients using callToolStream validate it
  // against the tool's outputSchema ({ok:true}), which would reject {ok:false}.
  const resultWithMeta = taskResult as Record<string, unknown>;
  assert.strictEqual(resultWithMeta['structuredContent'], undefined);
  assert.strictEqual(taskResult.isError, true);
});
