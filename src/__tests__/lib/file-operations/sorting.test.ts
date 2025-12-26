import { expect, it } from 'vitest';

import {
  sortByField,
  sortSearchResults,
} from '../../../lib/file-operations/sorting.js';

it('sortByField uses path as a deterministic tie-breaker for name sort', () => {
  const items = [
    { name: 'file.txt', path: '/b/file.txt' },
    { name: 'file.txt', path: '/a/file.txt' },
  ];

  sortByField(items, 'name');

  expect(items.map((item) => item.path)).toEqual([
    '/a/file.txt',
    '/b/file.txt',
  ]);
});

it('sortSearchResults uses path as a deterministic tie-breaker for name sort', () => {
  const results = [{ path: '/b/file.txt' }, { path: '/a/file.txt' }];

  sortSearchResults(results, 'name');

  expect(results.map((item) => item.path)).toEqual([
    '/a/file.txt',
    '/b/file.txt',
  ]);
});
