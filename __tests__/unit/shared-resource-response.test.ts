import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createInMemoryResourceStore } from '../../src/lib/resource-store.js';
import { buildResourceResponse, putResource } from '../../src/tools/shared.js';

test('buildResourceResponse: summary + resource_link blocks + structured', () => {
  const link = {
    type: 'resource_link' as const,
    uri: 'filesystem-mcp://result/abc',
    name: 'src/x.ts',
    mimeType: 'text/x-typescript',
    size: 10,
  };
  const r = buildResourceResponse({
    summary: 'read: src/x.ts · 1 line · 10 B · text/x-typescript',
    resources: [link],
    structured: { path: 'src/x.ts', size: 10 },
  });
  assert.equal(r.content[0]?.type, 'text');
  assert.equal(r.content[1], link);
  assert.deepEqual(r.structuredContent, { path: 'src/x.ts', size: 10 });
});

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
