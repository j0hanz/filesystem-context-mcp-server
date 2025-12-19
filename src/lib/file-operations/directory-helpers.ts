import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent, Stats } from 'node:fs';

import { Minimatch } from 'minimatch';

import type { DirectoryEntry, FileType } from '../../config/types.js';
import { ErrorCode, McpError } from '../errors.js';
import { getFileType, isHidden } from '../fs-helpers.js';
import { validateExistingPath } from '../path-validation.js';

// ============================================================================
// DIRECTORY ITERATION
// ============================================================================

export interface DirectoryIterationEntry {
  item: Dirent;
  name: string;
  fullPath: string;
  relativePath: string;
}

export interface DirectoryIterationOptions {
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

export async function forEachDirectoryEntry(
  currentPath: string,
  basePath: string,
  options: DirectoryIterationOptions,
  handler: (entry: DirectoryIterationEntry) => Promise<void>
): Promise<void> {
  const items = await readDirectoryEntries(currentPath, options.onInaccessible);
  if (!items) return;

  for (const item of items) {
    if (options.shouldStop?.()) break;
    const { name } = item;
    if (!options.includeHidden && isHidden(name)) continue;

    const fullPath = path.join(currentPath, name);
    const relativePath = path.relative(basePath, fullPath);
    if (options.shouldExclude(name, relativePath)) continue;

    await handler({ item, name, fullPath, relativePath });
  }
}

// ============================================================================
// DIRECTORY ITEM BUILDING
// ============================================================================

export interface DirectoryItemResult {
  entry: DirectoryEntry;
  enqueueDir?: { currentPath: string; depth: number };
  skippedInaccessible?: boolean;
  symlinkNotFollowed?: boolean;
}

interface DirectoryItemOptions {
  includeSymlinkTargets: boolean;
  recursive: boolean;
  depth: number;
  maxDepth: number;
}

function buildEntryBase(
  item: Dirent,
  fullPath: string,
  relativePath: string,
  type: FileType
): DirectoryEntry {
  return {
    name: item.name,
    path: fullPath,
    relativePath,
    type,
  };
}

function resolveEntryType(item: Dirent, stats: Stats): FileType {
  if (item.isDirectory()) return 'directory';
  if (item.isFile()) return 'file';
  return getFileType(stats);
}

async function buildSymlinkResult(
  item: Dirent,
  fullPath: string,
  relativePath: string,
  includeSymlinkTargets: boolean
): Promise<DirectoryItemResult> {
  const stats = await fs.lstat(fullPath);
  let symlinkTarget: string | undefined;

  if (includeSymlinkTargets) {
    try {
      symlinkTarget = await fs.readlink(fullPath);
    } catch {
      symlinkTarget = undefined;
    }
  }

  const entry: DirectoryEntry = {
    name: item.name,
    path: fullPath,
    relativePath,
    type: 'symlink',
    size: stats.size,
    modified: stats.mtime,
    symlinkTarget,
  };

  return { entry, symlinkNotFollowed: true };
}

async function buildEnqueueDir(
  fullPath: string,
  depth: number,
  maxDepth: number,
  recursive: boolean
): Promise<{ currentPath: string; depth: number } | undefined> {
  if (!recursive || depth + 1 > maxDepth) return undefined;

  return {
    currentPath: await validateExistingPath(fullPath),
    depth: depth + 1,
  };
}

async function buildRegularResult(
  item: Dirent,
  fullPath: string,
  relativePath: string,
  options: DirectoryItemOptions
): Promise<DirectoryItemResult> {
  const stats = await fs.stat(fullPath);
  const type = resolveEntryType(item, stats);

  const entry: DirectoryEntry = {
    ...buildEntryBase(item, fullPath, relativePath, type),
    size: type === 'file' ? stats.size : undefined,
    modified: stats.mtime,
  };

  const enqueueDir = await buildEnqueueDir(
    fullPath,
    options.depth,
    options.maxDepth,
    options.recursive
  );

  return { entry, enqueueDir };
}

function buildFallbackEntry(
  item: Dirent,
  fullPath: string,
  relativePath: string
): DirectoryItemResult {
  const type: FileType = item.isDirectory()
    ? 'directory'
    : item.isFile()
      ? 'file'
      : 'other';

  return {
    entry: buildEntryBase(item, fullPath, relativePath, type),
    skippedInaccessible: true,
  };
}

export async function buildDirectoryItemResult(
  item: Dirent,
  currentPath: string,
  basePath: string,
  options: DirectoryItemOptions
): Promise<DirectoryItemResult> {
  const fullPath = path.join(currentPath, item.name);
  const relativePath = path.relative(basePath, fullPath) || item.name;

  try {
    if (item.isSymbolicLink()) {
      return await buildSymlinkResult(
        item,
        fullPath,
        relativePath,
        options.includeSymlinkTargets
      );
    }

    return await buildRegularResult(item, fullPath, relativePath, options);
  } catch {
    return buildFallbackEntry(item, fullPath, relativePath);
  }
}
