/**
 * processEntriesConcurrently: which exit reason the dispatch loop reports.
 *
 * replace_text publishes the tracker's resolve() straight onto the wire
 * `stoppedReason` (maxFiles / maxResults / timeout). An abort used to break the
 * loop without setting any flag, so a cancelled or timed-out sweep reported no
 * reason at all and read as if every matching file had been enumerated.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { processEntriesConcurrently } from '../../src/core/concurrency.js';

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
  it('reports timeout when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    let dispatched = 0;
    const tracker = await processEntriesConcurrently(paths(5), {
      ...base,
      signal: controller.signal,
      onEntry: () => {
        dispatched++;
      },
    });

    assert.equal(tracker.resolve(), 'timeout', 'an aborted sweep must report a reason');
    assert.equal(tracker.truncated, true);
    assert.equal(dispatched, 0);
  });

  it('reports maxFiles when maxEntries is reached', async () => {
    const tracker = await processEntriesConcurrently(paths(5), {
      ...base,
      signal: undefined,
      maxEntries: 2,
    });

    assert.equal(tracker.resolve(), 'maxFiles');
  });

  it('reports maxResults when shouldStop turns true', async () => {
    let seen = 0;
    const tracker = await processEntriesConcurrently(paths(5), {
      ...base,
      signal: undefined,
      shouldStop: () => seen >= 2,
      onEntry: () => {
        seen++;
      },
    });

    assert.equal(tracker.resolve(), 'maxResults');
  });

  it('reports no reason when every entry is dispatched', async () => {
    let seen = 0;
    const tracker = await processEntriesConcurrently(paths(3), {
      ...base,
      signal: undefined,
      onEntry: () => {
        seen++;
      },
    });

    assert.equal(seen, 3);
    assert.equal(tracker.resolve(), undefined);
    assert.equal(tracker.truncated, false);
  });
});
