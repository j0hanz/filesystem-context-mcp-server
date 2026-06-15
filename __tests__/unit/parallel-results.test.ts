import assert from 'node:assert/strict';
import { test } from 'node:test';

import { processInParallel } from '../../src/core/concurrency.js';

test('processInParallel returns {index, value} entries in input order with no failures', async () => {
  const items = ['a', 'b', 'c'];
  const { results, errors } = await processInParallel(items, async (s) => s.toUpperCase());

  assert.equal(errors.length, 0);
  assert.equal(results.length, 3);
  assert.equal(results[0]?.index, 0);
  assert.equal(results[0]?.value, 'A');
  assert.equal(results[1]?.index, 1);
  assert.equal(results[1]?.value, 'B');
  assert.equal(results[2]?.index, 2);
  assert.equal(results[2]?.value, 'C');
});

test('processInParallel: partial failure preserves correct index in results and errors', async () => {
  // items[1] fails — results must NOT shift: items[2] result stays at index 2
  const items = [0, 1, 2, 3, 4];
  const { results, errors } = await processInParallel(items, async (n) => {
    if (n === 1) throw new Error('fail at 1');
    return n * 10;
  });

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.index, 1);
  assert.match(errors[0]?.error.message ?? '', /fail at 1/);

  assert.equal(results.length, 4);
  // Verify every result carries its original input index
  for (const { index, value } of results) {
    assert.equal(value, index * 10, `result at index ${index} has wrong value`);
  }
  // Confirm index 1 is absent from results
  const presentIndices = results.map((r) => r.index);
  assert.ok(!presentIndices.includes(1), 'index 1 should be absent from results');
});

test('processInParallel: all items fail returns empty results and all errors', async () => {
  const items = ['x', 'y', 'z'];
  const { results, errors } = await processInParallel(items, async (_s) => {
    throw new Error('always fail');
  });

  assert.equal(results.length, 0);
  assert.equal(errors.length, 3);
  const indices = errors.map((e) => e.index).sort((a, b) => a - b);
  assert.deepEqual(indices, [0, 1, 2]);
});

test('processInParallel: empty input returns empty results and errors', async () => {
  const { results, errors } = await processInParallel([], async (x: never) => x);
  assert.equal(results.length, 0);
  assert.equal(errors.length, 0);
});

test('processInParallel: abort signal after start surfaces abort error post-drain', async () => {
  const ctrl = new AbortController();
  const started: number[] = [];

  const promise = processInParallel(
    [0, 1, 2, 3, 4],
    async (n) => {
      started.push(n);
      if (n === 0) ctrl.abort();
      await new Promise((r) => setTimeout(r, 5));
      return n;
    },
    1,
    ctrl.signal,
  );

  await assert.rejects(promise, (err: Error) => {
    return err.name === 'AbortError' || /aborted/i.test(err.message);
  });
});
