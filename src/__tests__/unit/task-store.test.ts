import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode } from '../../lib/errors.js';
import { ResultAwareInMemoryTaskStore } from '../../server/task-store.js';

describe('ResultAwareInMemoryTaskStore', () => {
  it('returns a synthetic cancelled result when a task is cancelled before storing a payload', async () => {
    const store = new ResultAwareInMemoryTaskStore();
    try {
      const task = await store.createTask(
        { ttl: 1_000, pollInterval: 100 },
        1,
        { method: 'tools/call', params: {} },
        'test-session'
      );

      await store.updateTaskStatus(
        task.taskId,
        'cancelled',
        'Client cancelled task execution.',
        'test-session'
      );

      const rawResult = await store.getTaskResult(task.taskId, 'test-session');
      const result = CallToolResultSchema.parse(rawResult);
      assert.equal(result.isError, true);
      assert.equal(result.errorCode, ErrorCode.CANCELLED);

      const textBlock = result.content.find(
        (block): block is { type: 'text'; text: string } =>
          block.type === 'text' && typeof block.text === 'string'
      );
      assert.ok(textBlock, 'Expected a text error payload');
      assert.match(textBlock.text, /Client cancelled task execution\./u);
    } finally {
      store.cleanup();
    }
  });
});
