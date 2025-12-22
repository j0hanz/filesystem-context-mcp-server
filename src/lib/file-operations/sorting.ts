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

const SORT_COMPARATORS: Readonly<
  Record<SortField, (a: Sortable, b: Sortable) => number>
> = {
  size: (a, b) => (b.size ?? 0) - (a.size ?? 0),
  modified: (a, b) =>
    (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0),
  type: (a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return (a.name ?? '').localeCompare(b.name ?? '');
  },
  path: (a, b) => (a.path ?? '').localeCompare(b.path ?? ''),
  name: (a, b) => (a.name ?? '').localeCompare(b.name ?? ''),
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
    results.sort((a, b) =>
      path.basename(a.path ?? '').localeCompare(path.basename(b.path ?? ''))
    );
    return;
  }

  sortByField(results, sortBy);
}
