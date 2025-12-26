import * as path from 'node:path';

import type { FileType } from '../../config/types.js';

type SortField = 'name' | 'size' | 'modified' | 'type' | 'path';

interface Sortable {
  name?: string;
  size?: number;
  modified?: Date;
  type?: FileType;
  path?: string;
}

function compareString(a?: string, b?: string): number {
  return (a ?? '').localeCompare(b ?? '');
}

function compareNameThenPath(a: Sortable, b: Sortable): number {
  const nameCompare = compareString(a.name, b.name);
  if (nameCompare !== 0) return nameCompare;
  return compareString(a.path, b.path);
}

function comparePathThenName(a: Sortable, b: Sortable): number {
  const pathCompare = compareString(a.path, b.path);
  if (pathCompare !== 0) return pathCompare;
  return compareString(a.name, b.name);
}

const SORT_COMPARATORS: Readonly<
  Record<SortField, (a: Sortable, b: Sortable) => number>
> = {
  size: (a, b) => {
    const sizeCompare = (b.size ?? 0) - (a.size ?? 0);
    if (sizeCompare !== 0) return sizeCompare;
    return compareNameThenPath(a, b);
  },
  modified: (a, b) => {
    const timeCompare =
      (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0);
    if (timeCompare !== 0) return timeCompare;
    return compareNameThenPath(a, b);
  },
  type: (a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return compareNameThenPath(a, b);
  },
  path: (a, b) => comparePathThenName(a, b),
  name: (a, b) => compareNameThenPath(a, b),
};

export function sortByField(items: Sortable[], sortBy: SortField): void {
  const comparator = SORT_COMPARATORS[sortBy];
  items.sort(comparator);
}

export function sortSearchResults(
  results: Sortable[],
  sortBy: 'name' | 'size' | 'modified' | 'path'
): void {
  if (sortBy === 'name') {
    results.sort((a, b) => {
      const baseCompare = compareString(
        path.basename(a.path ?? ''),
        path.basename(b.path ?? '')
      );
      if (baseCompare !== 0) return baseCompare;
      return compareString(a.path, b.path);
    });
    return;
  }

  sortByField(results, sortBy);
}
