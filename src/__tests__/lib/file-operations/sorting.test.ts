import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
  sortByField,
  sortSearchResults,
} from '../../../lib/file-operations/sorting.js';

void it('sortByField uses path as a deterministic tie-breaker for name sort', () => {
  const items = [
    { name: 'file.txt', path: '/b/file.txt' },
    { name: 'file.txt', path: '/a/file.txt' },
  ];

  sortByField(items, 'name');

  assert.deepStrictEqual(
    items.map((item) => item.path),
    ['/a/file.txt', '/b/file.txt']
  );
});

void it('sortSearchResults uses path as a deterministic tie-breaker for name sort', () => {
  const results = [{ path: '/b/file.txt' }, { path: '/a/file.txt' }];

  sortSearchResults(results, 'name');

  assert.deepStrictEqual(
    results.map((item) => item.path),
    ['/a/file.txt', '/b/file.txt']
  );
});
