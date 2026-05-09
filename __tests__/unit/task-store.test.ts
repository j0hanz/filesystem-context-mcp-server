import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode } from '../../src/lib/errors.js';
import { ResultAwareInMemoryTaskStore } from '../../src/server/task-store.js';

describe('ResultAwareInMemoryTaskStore', () => {
  it('returns a synthetic cancelled result when a task is cancelled before storing a payload', async () => {
    const store = new ResultAwareInMemoryTaskStore();
    try {
      const task = await store.createTask(
        { ttl: 1_000, pollInterval: 100 },
        1,
        { method: 'tools/call', params: {} },
        'test-session',
      );

      await store.updateTaskStatus(
        task.taskId,
        'cancelled',
        'Client cancelled task execution.',
        'test-session',
      );

      const result = (await store.getTaskResult(task.taskId, 'test-session')) as {
        isError?: boolean;
        errorCode?: string;
        content: { type: string; text?: string }[];
      };
      assert.equal(result.isError, true);
      assert.equal(result.errorCode, ErrorCode.CANCELLED);

      const textBlock = result.content.find(
        (block: { type: string; text?: string }): block is { type: 'text'; text: string } =>
          block.type === 'text' && typeof block.text === 'string',
      );
      assert.ok(textBlock, 'Expected a text error payload');
      assert.match(textBlock.text, /Client cancelled task execution\./u);
    } finally {
      store.cleanup();
    }
  });

  describe('ResultAwareInMemoryTaskStore eviction threshold', () => {
    it('does not run eviction when result count is below threshold', async () => {
      const store = new ResultAwareInMemoryTaskStore();
      try {
        // Add 50 results (below default threshold of 100)
        for (let i = 0; i < 50; ++i) {
          const task = await store.createTask(
            { ttl: 60_000, pollInterval: 100 },
            1,
            { method: 'tools/call', params: {} },
            `session-${i}`,
          );

          await store.updateTaskStatus(
            task.taskId,
            'cancelled',
            'Test cancellation',
            `session-${i}`,
          );
        }

        // Verify all 50 results still in store
        const store1 = store as unknown as {
          cancelledResults: Map<string, unknown>;
        };
        assert.strictEqual(
          store1.cancelledResults.size,
          50,
          'All 50 cancelled results should be retained below threshold',
        );

        // Call getTaskResult to trigger eviction scan (which should not evict anything below threshold)
        const task = await store.createTask(
          { ttl: 60_000, pollInterval: 100 },
          1,
          { method: 'tools/call', params: {} },
          'test-session',
        );
        await store.updateTaskStatus(task.taskId, 'cancelled', 'Test', 'test-session');
        await store.getTaskResult(task.taskId, 'test-session');

        // Still 51 results (the newly added one + the original 50)
        assert.strictEqual(
          store1.cancelledResults.size,
          51,
          'No eviction should occur below threshold even when scan is triggered',
        );
      } finally {
        store.cleanup();
      }
    });

    it('runs eviction when result count exceeds threshold', async () => {
      const store = new ResultAwareInMemoryTaskStore();
      try {
        // Add 101 results with old timestamps (to trigger eviction)
        // We'll manipulate the store directly to simulate old entries
        const store1 = store as unknown as {
          cancelledResults: Map<string, { result: unknown; createdAt: number }>;
        };

        const oldTimestamp = Date.now() - 3 * 60 * 1000; // 3 minutes ago (beyond 2-minute TTL)

        for (let i = 0; i < 101; ++i) {
          store1.cancelledResults.set(`test-key-${i}`, {
            result: { isError: true, content: [] },
            createdAt: oldTimestamp,
          });
        }

        assert.strictEqual(
          store1.cancelledResults.size,
          101,
          'Should have 101 entries before eviction',
        );

        // Trigger eviction by calling getTaskResult
        const task = await store.createTask(
          { ttl: 60_000, pollInterval: 100 },
          1,
          { method: 'tools/call', params: {} },
          'trigger-session',
        );
        await store.updateTaskStatus(task.taskId, 'cancelled', 'Test', 'trigger-session');
        await store.getTaskResult(task.taskId, 'trigger-session');

        // After eviction, count should be reduced
        const finalCount = store1.cancelledResults.size;
        assert.ok(finalCount < 101, `Eviction should reduce count from 101, got ${finalCount}`);
        assert.ok(finalCount <= 100, `After eviction, count should be <= 100, got ${finalCount}`);
      } finally {
        store.cleanup();
      }
    });

    it('only performs expensive scan when exceeding threshold, not at threshold', async () => {
      const store = new ResultAwareInMemoryTaskStore();
      try {
        // Test the key behavior: below/at threshold should have cheaper operations
        const store1 = store as unknown as {
          cancelledResults: Map<string, { result: unknown; createdAt: number }>;
        };

        const oldTimestamp = Date.now() - 3 * 60 * 1000; // Expired entries

        // Add 99 entries (below threshold)
        for (let i = 0; i < 99; ++i) {
          store1.cancelledResults.set(`expired-${i}`, {
            result: { isError: true, content: [] },
            createdAt: oldTimestamp,
          });
        }

        // Add 1 fresh entry (not expired)
        store1.cancelledResults.set('fresh-entry', {
          result: { isError: true, content: [] },
          createdAt: Date.now(),
        });

        assert.strictEqual(
          store1.cancelledResults.size,
          100,
          'Should have exactly 100 entries at threshold',
        );

        // Call getTaskResult which would trigger evictExpired
        const task = await store.createTask(
          { ttl: 60_000, pollInterval: 100 },
          1,
          { method: 'tools/call', params: {} },
          'test-session',
        );
        await store.updateTaskStatus(task.taskId, 'cancelled', 'Test', 'test-session');
        await store.getTaskResult(task.taskId, 'test-session');

        // We now have 101 entries (the 100 we added + the one from updateTaskStatus)
        // On next getTaskResult call with > 100 entries, eviction should run
        const nextTask = await store.createTask(
          { ttl: 60_000, pollInterval: 100 },
          1,
          { method: 'tools/call', params: {} },
          'test-session-2',
        );
        await store.updateTaskStatus(nextTask.taskId, 'cancelled', 'Test', 'test-session-2');
        await store.getTaskResult(nextTask.taskId, 'test-session-2');

        // Now eviction should have run and removed expired entries
        // We should have fewer than 102 entries
        const finalCount = store1.cancelledResults.size;
        assert.ok(
          finalCount < 102,
          `After exceeding threshold, eviction should remove expired entries, got ${finalCount}`,
        );
      } finally {
        store.cleanup();
      }
    });
  });
});
