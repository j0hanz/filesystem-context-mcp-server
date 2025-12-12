import { Minimatch } from 'minimatch';

import { ErrorCode, McpError } from './errors.js';

// Create matcher from exclude patterns
export function createExcludeMatcher(
  excludePatterns: string[]
): (name: string, relativePath: string) => boolean {
  if (excludePatterns.length === 0) {
    return () => false;
  }
  const matchers = excludePatterns.map((pattern) => new Minimatch(pattern));
  return (name: string, relativePath: string): boolean =>
    matchers.some((m) => m.match(name) || m.match(relativePath));
}

// Handle directory operation errors (currently no-op)
export function handleDirectoryError(_error: unknown): void {
  void _error;
}

// Classify symlink/access errors for summary tracking
export function classifyAccessError(
  error: unknown
): 'symlink' | 'inaccessible' {
  if (
    error instanceof McpError &&
    (error.code === ErrorCode.E_ACCESS_DENIED ||
      error.code === ErrorCode.E_SYMLINK_NOT_ALLOWED)
  ) {
    return 'symlink';
  }
  return 'inaccessible';
}

// Insert item into sorted array maintaining sort order (descending by comparator)
export function insertSorted<T>(
  arr: T[],
  item: T,
  compare: (a: T, b: T) => boolean,
  maxLen: number
): void {
  if (maxLen <= 0) return;
  const idx = arr.findIndex((el) => compare(item, el));
  if (idx === -1) {
    if (arr.length < maxLen) arr.push(item);
  } else {
    arr.splice(idx, 0, item);
    if (arr.length > maxLen) arr.pop();
  }
}
