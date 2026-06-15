import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode, FsError } from '../../src/core/errors.js';
import { createInMemoryResourceStore } from '../../src/core/store.js';

describe('resource store', () => {
  it('expires entries on read and removes them from the key list', async () => {
    const store = createInMemoryResourceStore({ entryTtlMs: 5 });
    const entry = store.putText({ name: 'result', text: 'hello' });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.throws(
      () => store.getText(entry.uri),
      (error: unknown) =>
        error instanceof FsError &&
        error.code === ErrorCode.NOT_FOUND &&
        error.message.includes('Resource expired:'),
    );
    assert.deepEqual(store.keys(), []);
  });

  it('does not deduplicate cached resources across different mime types', () => {
    const store = createInMemoryResourceStore();
    const textEntry = store.putText({
      name: 'text',
      mimeType: 'text/plain',
      text: 'same payload',
    });
    const jsonEntry = store.putText({
      name: 'json',
      mimeType: 'application/json',
      text: 'same payload',
    });

    assert.notEqual(textEntry.uri, jsonEntry.uri);
    assert.equal(store.keys().length, 2);
  });

  it('evicts least recently used entries when limits are reached', () => {
    const store = createInMemoryResourceStore({ maxEntries: 2 });
    const entry1 = store.putText({ name: '1', text: 'one' });
    store.putText({ name: '2', text: 'two' });

    // Access entry1 to make it recently used
    store.getText(entry1.uri);

    // Add entry3, which should evict entry2 instead of entry1
    const entry3 = store.putText({ name: '3', text: 'three' });

    assert.deepEqual(store.keys().sort(), [entry1.uri, entry3.uri].sort());
  });

  it('does not mutate the previously returned entry on dedup-hit with a different name', () => {
    const store = createInMemoryResourceStore();
    const first = store.putText({ name: 'original', text: 'hello' });
    const snapshotName = first.name;
    const snapshotExpiry = first.expiresAt;
    store.putText({ name: 'updated', text: 'hello' });
    assert.equal(first.name, snapshotName);
    assert.equal(first.expiresAt, snapshotExpiry);
  });

  it('prunes multiple expired entries without iterator corruption', async () => {
    const store = createInMemoryResourceStore({ entryTtlMs: 10, maxEntries: 10 });
    store.putText({ name: 'a', text: 'one' });
    store.putText({ name: 'b', text: 'two' });
    store.putText({ name: 'c', text: 'three' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(store.keys().length, 0);
  });

  it('does not emit cache_store when entry is immediately evicted', async () => {
    const { channel } = await import('node:diagnostics_channel');
    const ch = channel('filesystem-mcp:resource-store');
    const phases: string[] = [];
    const sub = (msg: unknown) => phases.push((msg as { phase: string }).phase);
    ch.subscribe(sub);
    try {
      // maxEntries: 0 causes any inserted entry to be immediately evicted by enforceLimits
      const store = createInMemoryResourceStore({ maxEntries: 0 });
      assert.throws(() => store.putText({ name: 'x', text: 'hello world' }));
      assert.ok(!phases.includes('cache_store'), 'cache_store must not fire for evicted entries');
      assert.ok(phases.includes('cache_reject'), 'cache_reject must fire');
    } finally {
      ch.unsubscribe(sub);
    }
  });

  it('throws at construction when maxEntryBytes exceeds maxTotalBytes', () => {
    assert.throws(
      () => createInMemoryResourceStore({ maxEntryBytes: 500, maxTotalBytes: 100 }),
      (err: unknown) => err instanceof Error && (err).message.includes('maxEntryBytes'),
    );
  });
});
