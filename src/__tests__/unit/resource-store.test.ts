import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode, McpError } from '../../lib/errors.js';
import { createInMemoryResourceStore } from '../../lib/resource-store.js';

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
        error.message.includes('Resource expired:')
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
});
