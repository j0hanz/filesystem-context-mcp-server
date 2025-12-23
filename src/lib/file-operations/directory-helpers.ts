import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dir, Dirent } from 'node:fs';

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

async function openDirectory(
  currentPath: string,
  onInaccessible: () => void
): Promise<Dir | null> {
  try {
    return await fs.opendir(currentPath);
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

async function iterateDirectoryEntries(
  dir: Dir,
  currentPath: string,
  basePath: string,
  options: DirectoryIterationOptions,
  handler: (entry: DirectoryIterationEntry) => Promise<void>
): Promise<void> {
  const shouldStop = options.shouldStop ?? (() => false);

  for await (const item of dir) {
    if (shouldStop()) break;
    const entry = buildIterationEntry(currentPath, basePath, item);
    if (shouldSkipEntry(entry, options)) continue;
    await handler(entry);
  }
}

export async function forEachDirectoryEntry(
  currentPath: string,
  basePath: string,
  options: DirectoryIterationOptions,
  handler: (entry: DirectoryIterationEntry) => Promise<void>
): Promise<void> {
  const dir = await openDirectory(currentPath, options.onInaccessible);
  if (!dir) return;

  try {
    await iterateDirectoryEntries(dir, currentPath, basePath, options, handler);
  } catch {
    options.onInaccessible();
  } finally {
    await dir.close().catch(() => {});
  }
}
