import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { runInWorker, shutdownWorkerPool } from '../../src/core/concurrency.js';
import { ErrorCode } from '../../src/core/errors.js';
import { FsError } from '../../src/core/errors.js';

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
    return err instanceof FsError && err.code === ErrorCode.TIMEOUT;
  });

  ctrl.abort(); // cancel the background workers so test finishes fast
  await Promise.all(workers);

  await shutdownWorkerPool();
});

test('runInWorker rejects with backpressure error when queue reaches capacity', async () => {
  // This test verifies queue saturation behavior by submitting tasks faster than
  // they can be processed. We use moderate-sized strings and rapid submission to
  // trigger queue saturation without excessive runtime.
  //
  // Strategy: Submit ~150 tasks rapidly and expect some rejections when queue
  // capacity (WORKER_QUEUE_MAX, default 100) is exceeded.

  const moderateStr1 = 'a\n'.repeat(200);
  const moderateStr2 = 'b\n'.repeat(200);

  const results: { status: 'completed' | 'rejected'; error?: Error }[] = [];

  // Attempt to submit more tasks than can fit in queue + worker slots.
  // With default WORKER_QUEUE_MAX=100 and 4 workers, expect rejections around task 104+.
  const submissions = Array.from({ length: 150 }, async (_, i) => {
    try {
      // Submit diff task with moderate input. Many will queue, some will be rejected.
      await runInWorker('diff', {
        oldStr: moderateStr1,
        newStr: moderateStr2,
        oldHeader: `file_${String(i)}`,
        newHeader: `file_${String(i)}`,
      });
      results.push({ status: 'completed' });
    } catch (error) {
      results.push({ status: 'rejected', error: error as Error });
    }
  });

  await Promise.all(submissions);

  // At least some submissions should have been rejected due to queue saturation.
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.ok(
    rejected.length > 0,
    'Expected at least one submission to be rejected due to queue saturation',
  );

  // Verify rejected items have the expected backpressure error.
  for (const item of rejected) {
    if (item.error) {
      assert.match(
        item.error.message,
        /queue is full|backpressure/i,
        `Expected queue saturation error, got: ${item.error.message}`,
      );
    }
  }

  await shutdownWorkerPool();
});
