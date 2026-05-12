import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SearchWorkerPool } from '../../src/tools/search-content.js';

describe('SearchWorkerPool', () => {
  it('retires a worker when posting a scan request fails', async () => {
    const pool = new SearchWorkerPool(1, false);

    let terminateCalls = 0;
    const fakeWorker = {
      postMessage: () => {
        throw new Error('post failed');
      },
      terminate: async () => {
        terminateCalls += 1;
        return 0;
      },
    };

    const poolState = pool as unknown as {
      workers: (typeof fakeWorker | undefined)[];
    };
    poolState.workers[0] = fakeWorker;

    const task = pool.scan({
      resolvedPath: 'x',
      requestedPath: 'x',
      pattern: 'needle',
      matcherOptions: {
        caseSensitive: false,
        wholeWord: false,
        isLiteral: true,
      },
      scanOptions: {
        maxFileSize: 1024,
        skipBinary: true,
        contextLines: 0,
        contextBefore: 0,
        contextAfter: 0,
      },
      maxMatches: 1,
    });

    await assert.rejects(task.promise, /post failed/u);
    assert.equal(terminateCalls, 1, 'worker should be terminated exactly once');
    assert.equal(poolState.workers[0], undefined, 'retired worker slot should be cleared');

    await pool.close();
  });
});
