import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createInMemoryResourceStore } from '../../src/core/store.js';
import { putJsonResource } from '../../src/tools/_helpers.js';

test('putJsonResource: stores pretty JSON and returns a resource_link', () => {
  const store = createInMemoryResourceStore();
  const { entry, link } = putJsonResource(store, 'src/x.json', { x: 1 });

  assert.equal(link.type, 'resource_link');
  assert.equal(link.mimeType, 'application/json');
  assert.equal(entry.mimeType, 'application/json');
  assert.equal(link.size, entry.size);
  assert.deepEqual(link.annotations?.audience, ['user']);
  assert.equal(store.getText(entry.uri).text, '{\n  "x": 1\n}');
});
