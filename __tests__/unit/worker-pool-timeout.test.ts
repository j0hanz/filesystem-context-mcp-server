import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { ErrorCode } from '../../src/config.js';
import { McpError } from '../../src/lib/errors.js';
import { runInWorker, shutdownWorkerPool } from '../../src/lib/worker-pool.js';

test('runInWorker removes task from queue on timeout', async () => {
  // Fill the pool to force queueing with moderately sized tasks
  const largeStr1 = 'a\n'.repeat(500);
  const largeStr2 = 'b\n'.repeat(500);

  const ctrl = new AbortController();
  const workers = Array.from({ length: 16 }).map(() =>
    runInWorker(
      'createPatch',
      { oldStr: largeStr1, newStr: largeStr2, oldHeader: '', newHeader: '' },
      { signal: ctrl.signal },
    ).catch(() => {}),
  );

  // Queue a task with a very short timeout.
  const timedOutTask = runInWorker(
    'createPatch',
    { oldStr: 'x', newStr: 'y', oldHeader: '', newHeader: '' },
    { timeoutMs: 1 },
  );

  await assert.rejects(timedOutTask, (err: unknown) => {
    return err instanceof McpError && err.code === ErrorCode.TIMEOUT;
  });

  ctrl.abort(); // cancel the background workers so test finishes fast
  await Promise.all(workers);

  await shutdownWorkerPool();
});
