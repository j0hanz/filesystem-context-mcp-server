import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode, McpError } from '../../src/core/errors.js';
import { createInMemoryResourceStore } from '../../src/core/store.js';

describe('resource store', () => {
  it('expires entries on read and removes them from the key list', async () => {
    const store = createInMemoryResourceStore({ entryTtlMs: 5 });
    const entry = store.putText({ name: 'result', text: 'hello' });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.throws(
      () => store.getText(entry.uri),
      (error: unknown) =>
        error instanceof McpError &&
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
});
