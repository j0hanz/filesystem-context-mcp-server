import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dir, Dirent } from 'node:fs';

import { minimatch } from 'minimatch';
import type { Minimatch } from 'minimatch';

import { isHidden } from '../fs-helpers.js';
import { withAbort } from '../fs-helpers/abort.js';

const EXCLUDE_MATCH_OPTIONS = {
  dot: true,
  nocase: process.platform === 'win32',
  windowsPathsNoEscape: true,
};

const PATTERN_MATCH_OPTIONS = {
  dot: true,
};

async function openDirectory(
  currentPath: string,
  onInaccessible: () => void,
  signal?: AbortSignal
): Promise<Dir | null> {
  try {
    return await withAbort(fs.opendir(currentPath), signal);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    onInaccessible();
    return null;
  }
}

export function buildExcludeMatchers(excludePatterns: string[]): Minimatch[] {
  if (excludePatterns.length === 0) return [];
  return excludePatterns.map(
    (pattern) => new minimatch.Minimatch(pattern, EXCLUDE_MATCH_OPTIONS)
  );
}

export function buildPatternMatcher(
  pattern: string | undefined
): Minimatch | undefined {
  if (!pattern) return undefined;
  return new minimatch.Minimatch(pattern, PATTERN_MATCH_OPTIONS);
}

function shouldExcludeEntry(
  item: Dirent,
  currentPath: string,
  basePath: string,
  excludeMatchers: Minimatch[]
): boolean {
  if (excludeMatchers.length === 0) return false;
  const relativePath =
    path.relative(basePath, path.join(currentPath, item.name)) || item.name;
  const normalizedRelative = relativePath.replace(/\\/g, '/');
  return excludeMatchers.some(
    (matcher) => matcher.match(item.name) || matcher.match(normalizedRelative)
  );
}

function shouldIncludeEntry(
  item: Dirent,
  currentPath: string,
  basePath: string,
  options: { includeHidden: boolean; excludeMatchers: Minimatch[] }
): boolean {
  if (!options.includeHidden && isHidden(item.name)) return false;
  if (
    shouldExcludeEntry(item, currentPath, basePath, options.excludeMatchers)
  ) {
    return false;
  }
  return true;
}

export async function* streamVisibleItems(
  currentPath: string,
  basePath: string,
  includeHidden: boolean,
  excludeMatchers: Minimatch[],
  onInaccessible: () => void,
  onScanned: () => void,
  onVisible: () => void,
  signal?: AbortSignal
): AsyncIterable<Dirent> {
  if (signal?.aborted) return;
  const dir = await openDirectory(currentPath, onInaccessible, signal);
  if (!dir) return;

  try {
    yield* iterateVisibleItems(dir, currentPath, basePath, {
      includeHidden,
      excludeMatchers,
      onScanned,
      onVisible,
      signal,
    });
  } catch {
    onInaccessible();
  } finally {
    await dir.close().catch(() => {});
  }
}

async function* iterateVisibleItems(
  dir: Dir,
  currentPath: string,
  basePath: string,
  options: {
    includeHidden: boolean;
    excludeMatchers: Minimatch[];
    onScanned: () => void;
    onVisible: () => void;
    signal?: AbortSignal;
  }
): AsyncIterable<Dirent> {
  for await (const item of dir) {
    if (options.signal?.aborted) break;
    if (!handleStreamItem(item, currentPath, basePath, options)) {
      continue;
    }
    yield item;
  }
}

function handleStreamItem(
  item: Dirent,
  currentPath: string,
  basePath: string,
  options: {
    includeHidden: boolean;
    excludeMatchers: Minimatch[];
    onScanned: () => void;
    onVisible: () => void;
  }
): boolean {
  options.onScanned();
  if (
    !shouldIncludeEntry(item, currentPath, basePath, {
      includeHidden: options.includeHidden,
      excludeMatchers: options.excludeMatchers,
    })
  ) {
    return false;
  }
  options.onVisible();
  return true;
}
