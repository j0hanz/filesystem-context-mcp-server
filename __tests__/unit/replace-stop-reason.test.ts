/**
 * processEntriesConcurrently: which exit reason the dispatch loop reports.
 *
 * handleSearchAndReplace maps these flags onto the wire `stoppedReason`
 * (maxFiles / maxResults / timeout). An abort used to break the loop without
 * setting any flag, so a cancelled or timed-out sweep reported no reason at all
 * and read as if every matching file had been enumerated.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { processEntriesConcurrently } from '../../src/tools/replace-in-files.js';

async function* paths(count: number): AsyncGenerator<{ path: string }> {
  for (let i = 0; i < count; i++) {
    yield { path: `/tmp/f${String(i)}.txt` };
  }
}

const base = {
  concurrency: 4,
  onEntry: (): void => {},
  runEntry: async (): Promise<void> => {},
};

describe('processEntriesConcurrently — exit reasons', () => {
  it('reports stoppedByAbort when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    let dispatched = 0;
    const result = await processEntriesConcurrently(paths(5), {
      ...base,
      signal: controller.signal,
      onEntry: () => {
        dispatched++;
      },
    });

    assert.equal(result.stoppedByAbort, true, 'an aborted sweep must report a reason');
    assert.equal(result.stoppedByLimit, false);
    assert.equal(result.stoppedByMatchCap, false);
    assert.equal(dispatched, 0);
  });

  it('reports stoppedByLimit when maxEntries is reached', async () => {
    const result = await processEntriesConcurrently(paths(5), {
      ...base,
      signal: undefined,
      maxEntries: 2,
    });

    assert.equal(result.stoppedByLimit, true);
    assert.equal(result.stoppedByAbort, false);
  });

  it('reports stoppedByMatchCap when shouldStop turns true', async () => {
    let seen = 0;
    const result = await processEntriesConcurrently(paths(5), {
      ...base,
      signal: undefined,
      shouldStop: () => seen >= 2,
      onEntry: () => {
        seen++;
      },
    });

    assert.equal(result.stoppedByMatchCap, true);
    assert.equal(result.stoppedByAbort, false);
  });

  it('reports no reason when every entry is dispatched', async () => {
    let seen = 0;
    const result = await processEntriesConcurrently(paths(3), {
      ...base,
      signal: undefined,
      onEntry: () => {
        seen++;
      },
    });

    assert.equal(seen, 3);
    assert.equal(result.stoppedByAbort, false);
    assert.equal(result.stoppedByLimit, false);
    assert.equal(result.stoppedByMatchCap, false);
  });
});
