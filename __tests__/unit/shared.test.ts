import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createInMemoryResourceStore } from '../../src/core/store.js';
import { putResource } from '../../src/tools/_helpers.js';
import { readResourceLink } from '../helpers.js';

describe('readResourceLink helper', () => {
  it('fetches text resource from store', async () => {
    const store = createInMemoryResourceStore();
    const { link } = putResource({
      store,
      name: 'test.txt',
      mimeType: 'text/plain',
      kind: 'text',
      content: 'hello world',
    });

    const result = await readResourceLink(store, {
      content: [link],
    });

    assert.equal(result?.text, 'hello world');
    assert.equal(result?.mimeType, 'text/plain');
    assert.equal(result?.size, 11);
    assert.equal(result?.blob, undefined);
  });

  it('fetches blob resource from store', async () => {
    const store = createInMemoryResourceStore();
    const testData = Buffer.from('binary data');
    const { link } = putResource({
      store,
      name: 'test.bin',
      mimeType: 'application/octet-stream',
      kind: 'blob',
      content: testData,
    });

    const result = await readResourceLink(store, {
      content: [link],
    });

    assert.deepEqual(result?.blob, testData);
    assert.equal(result?.mimeType, 'application/octet-stream');
    assert.equal(result?.size, testData.length);
    assert.equal(result?.text, undefined);
  });

  it('returns null when no resource_link found', async () => {
    const store = createInMemoryResourceStore();
    const result = await readResourceLink(store, {
      content: [{ type: 'text', text: 'some text' }],
    });

    assert.equal(result, null);
  });

  it('returns null when result has no content', async () => {
    const store = createInMemoryResourceStore();
    const result = await readResourceLink(store, {});

    assert.equal(result, null);
  });

  it('returns null when resource_link uri is not found in store', async () => {
    const store = createInMemoryResourceStore();
    const result = await readResourceLink(store, {
      content: [{ type: 'resource_link', uri: 'filesystem-mcp://resource/notfound' }],
    });

    assert.equal(result, null);
  });
});
