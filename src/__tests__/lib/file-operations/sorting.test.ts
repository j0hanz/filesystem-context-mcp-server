import { expect, it } from 'vitest';

import {
  sortByField,
  sortSearchResults,
} from '../../../lib/file-operations/sorting.js';

it('sortByField sorts by size descending', () => {
  const items = [{ size: 5 }, { size: 1 }, { size: 10 }];
  sortByField(items, 'size');
  expect(items.map((item) => item.size)).toEqual([10, 5, 1]);
});

it('sortByField sorts by modified date descending', () => {
  const items = [
    { modified: new Date('2024-01-01') },
    { modified: new Date('2023-01-01') },
    { modified: new Date('2025-01-01') },
  ];
  sortByField(items, 'modified');
  const [first] = items;
  if (!first) throw new Error('Expected sorted items');
  expect(first.modified.getUTCFullYear()).toBe(2025);
});

it('sortByField sorts directories before files when sorting by type', () => {
  const items: { type: 'file' | 'directory'; name: string }[] = [
    { type: 'file', name: 'b' },
    { type: 'directory', name: 'a' },
  ];
  sortByField(items, 'type');
  const [first] = items;
  if (!first) throw new Error('Expected sorted items');
  expect(first.type).toBe('directory');
});

it('sortSearchResults sorts by basename when sortBy=name', () => {
  const items = [{ path: '/z/beta.txt' }, { path: '/a/alpha.txt' }];
  sortSearchResults(items, 'name');
  const [first] = items;
  if (!first) throw new Error('Expected sorted items');
  expect(first.path).toBe('/a/alpha.txt');
});

it('sortSearchResults delegates to sortByField for non-name sorting', () => {
  const items = [{ path: '/b/file.txt' }, { path: '/a/file.txt' }];
  sortSearchResults(items, 'path');
  const [first] = items;
  if (!first) throw new Error('Expected sorted items');
  expect(first.path).toBe('/a/file.txt');
});
