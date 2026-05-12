import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createInMemoryResourceStore } from '../../src/core/store.js';
import { putResource } from '../../src/tools/_helpers.js';

test('putResource: text kind uses putText and returns resource_link', () => {
  const store = createInMemoryResourceStore();
  const { entry, link } = putResource({
    store,
    name: 'src/x.ts',
    mimeType: 'text/x-typescript',
    kind: 'text',
    content: 'export const x = 1;',
  });
  assert.equal(link.type, 'resource_link');
  assert.equal(link.mimeType, 'text/x-typescript');
  assert.equal(link.size, entry.size);
  assert.deepEqual(link.annotations?.audience, ['user']);
});

test('putResource: image kind uses putBlob', () => {
  const store = createInMemoryResourceStore();
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const { link } = putResource({
    store,
    name: 'logo.png',
    mimeType: 'image/png',
    kind: 'image',
    content: data,
  });
  assert.equal(link.mimeType, 'image/png');
  assert.equal(link.size, 4);
});
