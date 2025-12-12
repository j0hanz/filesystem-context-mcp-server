import * as path from 'node:path';

import type { FileType } from '../config/types.js';

// Common sortable entry interface
export interface SortableEntry {
  name?: string;
  size?: number;
  modified?: Date;
  type?: FileType;
  path?: string;
}

// Create a reusable comparator function based on sort criteria
export function createSorter<T extends SortableEntry>(
  sortBy: 'name' | 'size' | 'modified' | 'type' | 'path'
): (a: T, b: T) => number {
  return (a: T, b: T): number => {
    switch (sortBy) {
      case 'size':
        return (b.size ?? 0) - (a.size ?? 0);
      case 'modified':
        return (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0);
      case 'type':
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return (a.name ?? '').localeCompare(b.name ?? '');
      case 'path':
        return (a.path ?? '').localeCompare(b.path ?? '');
      case 'name':
      default:
        return (a.name ?? '').localeCompare(b.name ?? '');
    }
  };
}

// Specialized sorter for search results that extracts basename for name sorting
export function createSearchResultSorter(
  sortBy: 'name' | 'size' | 'modified' | 'path'
): (a: SortableEntry, b: SortableEntry) => number {
  return (a: SortableEntry, b: SortableEntry): number => {
    switch (sortBy) {
      case 'size':
        return (b.size ?? 0) - (a.size ?? 0);
      case 'modified':
        return (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0);
      case 'name':
        return path
          .basename(a.path ?? '')
          .localeCompare(path.basename(b.path ?? ''));
      case 'path':
      default:
        return (a.path ?? '').localeCompare(b.path ?? '');
    }
  };
}
