import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';

import { Minimatch } from 'minimatch';

import { ErrorCode, McpError } from '../errors.js';
import { isHidden } from '../fs-helpers.js';

// ============================================================================
// DIRECTORY ITERATION
// ============================================================================

interface DirectoryIterationEntry {
  item: Dirent;
  name: string;
  fullPath: string;
  relativePath: string;
}

interface DirectoryIterationOptions {
  includeHidden: boolean;
  shouldExclude: (name: string, relativePath: string) => boolean;
  onInaccessible: () => void;
  shouldStop?: () => boolean;
}

const MATCHER_OPTIONS = {
  dot: true,
  nocase: process.platform === 'win32',
  windowsPathsNoEscape: true,
} as const;

export function createExcludeMatcher(
  excludePatterns: string[]
): (name: string, relativePath: string) => boolean {
  if (excludePatterns.length === 0) {
    return () => false;
  }

  const matchers = excludePatterns.map(
    (pattern) => new Minimatch(pattern, MATCHER_OPTIONS)
  );

  return (name: string, relativePath: string): boolean => {
    const normalizedRelativePath = relativePath.replace(/\\/g, '/');
    return matchers.some(
      (matcher) => matcher.match(name) || matcher.match(normalizedRelativePath)
    );
  };
}

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

async function readDirectoryEntries(
  currentPath: string,
  onInaccessible: () => void
): Promise<Dirent[] | null> {
  try {
    return await fs.readdir(currentPath, { withFileTypes: true });
  } catch {
    onInaccessible();
    return null;
  }
}

function buildIterationEntry(
  currentPath: string,
  basePath: string,
  item: Dirent
): DirectoryIterationEntry {
  const fullPath = path.join(currentPath, item.name);
  const relativePath = path.relative(basePath, fullPath);
  return {
    item,
    name: item.name,
    fullPath,
    relativePath,
  };
}

function shouldSkipEntry(
  entry: DirectoryIterationEntry,
  options: DirectoryIterationOptions
): boolean {
  if (!options.includeHidden && isHidden(entry.name)) return true;
  if (options.shouldExclude(entry.name, entry.relativePath)) return true;
  return false;
}

export async function forEachDirectoryEntry(
  currentPath: string,
  basePath: string,
  options: DirectoryIterationOptions,
  handler: (entry: DirectoryIterationEntry) => Promise<void>
): Promise<void> {
  const items = await readDirectoryEntries(currentPath, options.onInaccessible);
  if (!items) return;
  await iterateDirectoryEntries(items, currentPath, basePath, options, handler);
}

async function iterateDirectoryEntries(
  items: Dirent[],
  currentPath: string,
  basePath: string,
  options: DirectoryIterationOptions,
  handler: (entry: DirectoryIterationEntry) => Promise<void>
): Promise<void> {
  const shouldStop = options.shouldStop ?? (() => false);

  for (const item of items) {
    if (shouldStop()) break;
    const entry = buildIterationEntry(currentPath, basePath, item);
    if (shouldSkipEntry(entry, options)) continue;
    await handler(entry);
  }
}
