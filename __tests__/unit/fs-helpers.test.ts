import assert from 'node:assert';
import { describe, it } from 'node:test';

import { processInParallel } from '../../src/core/concurrency.js';

describe('processInParallel', () => {
  it('correctly handles results containing undefined', async () => {
    const results = await processInParallel([1, 2, 3], async (n) => (n === 2 ? undefined : n * 10));
    assert.deepEqual(results.results, [10, undefined, 30]);
    assert.deepEqual(results.errors, []);
  });

  it('correctly handles mixed results with some undefined', async () => {
    const results = await processInParallel(['a', 'b', 'c'], async (s) =>
      s === 'a' || s === 'c' ? undefined : s.toUpperCase(),
    );
    assert.deepEqual(results.results, [undefined, 'B', undefined]);
    assert.deepEqual(results.errors, []);
  });

  it('correctly handles all results as undefined', async () => {
    const results = await processInParallel([1, 2, 3], async () => undefined);
    assert.deepEqual(results.results, [undefined, undefined, undefined]);
    assert.deepEqual(results.errors, []);
  });
});
