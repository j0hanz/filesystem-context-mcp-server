import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EventedTaskStore } from '../../src/tasks.js';

describe('EventedTaskStore', () => {
  it('emits "cancelled" event when a task status is updated to cancelled', async () => {
    const store = new EventedTaskStore();
    try {
      const task = await store.createTask(
        { ttl: 1_000, pollInterval: 100 },
        1,
        { method: 'tools/call', params: {} },
        'test-session',
      );

      let emittedTaskId: string | undefined;
      store.events.on('cancelled', (taskId: string) => {
        emittedTaskId = taskId;
      });

      await store.updateTaskStatus(
        task.taskId,
        'cancelled',
        'Client cancelled task execution.',
        'test-session',
      );

      assert.strictEqual(emittedTaskId, task.taskId);
    } finally {
      store.cleanup();
    }
  });
});
