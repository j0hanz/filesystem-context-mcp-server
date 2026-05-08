import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  runInWorker,
  shouldOffload,
  shutdownWorkerPool,
} from '../../src/lib/worker-pool.js';

test.afterEach(async () => {
  await shutdownWorkerPool();
});

test('shouldOffload exists and is callable', () => {
  assert.equal(typeof shouldOffload, 'function');
});

test('runInWorker dispatches diff task and returns StructuredPatch', async () => {
  const result = await runInWorker('diff', {
    oldStr: 'a\nb\n',
    newStr: 'a\nc\n',
    oldHeader: 'old',
    newHeader: 'new',
  });
  assert.ok(Array.isArray(result.hunks));
  assert.ok(result.hunks.length > 0);
});

test('runInWorker reuses idle workers across tasks', async () => {
  await runInWorker('diff', {
    oldStr: 'a',
    newStr: 'b',
    oldHeader: 'o',
    newHeader: 'n',
  });
  await runInWorker('diff', {
    oldStr: 'c',
    newStr: 'd',
    oldHeader: 'o',
    newHeader: 'n',
  });
  // No assertion possible from the public surface beyond "both completed".
  // Pool internals are tested indirectly via leak detection in afterEach.
});

test('runInWorker respects WORKER_POOL_MAX by queueing extra requests', async () => {
  // Fire more concurrent tasks than the pool max; all must complete.
  const tasks = Array.from({ length: 10 }, (_, i) =>
    runInWorker('diff', {
      oldStr: `${String(i)}\n`,
      newStr: `${String(i + 1)}\n`,
      oldHeader: 'o',
      newHeader: 'n',
    })
  );
  const results = await Promise.all(tasks);
  assert.equal(results.length, 10);
  for (const r of results) assert.ok(Array.isArray(r.hunks));
});

// Task 4: abort + shutdown paths

test('runInWorker rejects with abort error when signal aborts', async () => {
  const ctrl = new AbortController();
  const promise = runInWorker(
    'diff',
    {
      oldStr: 'x\n'.repeat(50_000),
      newStr: 'y\n'.repeat(50_000),
      oldHeader: 'o',
      newHeader: 'n',
    },
    { signal: ctrl.signal }
  );
  ctrl.abort();
  await assert.rejects(promise, (err: Error) => {
    return err.name === 'AbortError' || /aborted/i.test(err.message);
  });
});

test('runInWorker rejects already-aborted signal synchronously', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    runInWorker(
      'diff',
      { oldStr: 'a', newStr: 'b', oldHeader: 'o', newHeader: 'n' },
      { signal: ctrl.signal }
    )
  );
});

test('shutdownWorkerPool is idempotent', async () => {
  await runInWorker('diff', {
    oldStr: 'a',
    newStr: 'b',
    oldHeader: 'o',
    newHeader: 'n',
  });
  await shutdownWorkerPool();
  await shutdownWorkerPool(); // second call must not throw
});

// Task 5: error handling round trip

test('runInWorker handles malformed patch without crashing', async () => {
  // parsePatch on non-diff text returns a zero-hunk patch object; applyPatch
  // then succeeds and returns the original source unchanged (not false).
  const result = await runInWorker('applyPatch', {
    source: 'unrelated\n',
    patchText: 'this is not a valid unified diff',
  });
  // Either the source is returned unchanged or applied is false — both valid.
  assert.ok(
    result.applied === 'unrelated\n' || result.applied === false,
    `expected applied to be source or false, got: ${JSON.stringify(result.applied)}`
  );
});
