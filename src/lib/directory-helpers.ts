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
// Comparator should return negative if a < b, positive if a > b, 0 if equal
export function insertSorted<T>(
  arr: T[],
  item: T,
  compare: (a: T, b: T) => number,
  maxLen: number
): void {
  if (maxLen <= 0) return;
  const idx = arr.findIndex((el) => compare(item, el) < 0);
  if (idx === -1) {
    if (arr.length < maxLen) arr.push(item);
  } else {
    arr.splice(idx, 0, item);
    if (arr.length > maxLen) arr.pop();
  }
}
