import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent, Stats } from 'node:fs';

import type { DirectoryEntry } from '../../config/types.js';
import { withAbort } from '../fs-helpers/abort.js';
import { validateExistingPathDetailed } from '../path-validation.js';

export interface DirectoryItemResult {
  entry: DirectoryEntry;
  enqueueDir?: { currentPath: string; depth: number };
  skippedInaccessible?: boolean;
  symlinkNotFollowed?: boolean;
}

function buildEntryBase(
  item: Dirent,
  fullPath: string,
  relativePath: string,
  type: DirectoryEntry['type']
): DirectoryEntry {
  return {
    name: item.name,
    path: fullPath,
    relativePath,
    type,
  };
}

function resolveEntryType(stats: Stats): DirectoryEntry['type'] {
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  if (stats.isSymbolicLink()) return 'symlink';
  return 'other';
}

async function buildSymlinkResult(
  item: Dirent,
  fullPath: string,
  relativePath: string,
  includeSymlinkTargets: boolean,
  stats: Stats,
  signal?: AbortSignal
): Promise<DirectoryItemResult> {
  const symlinkTarget = await resolveSymlinkTarget(
    fullPath,
    includeSymlinkTargets,
    signal
  );

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

async function resolveSymlinkTarget(
  fullPath: string,
  includeSymlinkTargets: boolean,
  signal?: AbortSignal
): Promise<string | undefined> {
  if (!includeSymlinkTargets) return undefined;
  try {
    const symlinkTarget = await withAbort(fs.readlink(fullPath), signal);
    await validateExistingPathDetailed(fullPath, signal);
    return symlinkTarget;
  } catch {
    return undefined;
  }
}

function buildEnqueueDir(
  fullPath: string,
  depth: number,
  maxDepth: number,
  recursive: boolean
): { currentPath: string; depth: number } | undefined {
  if (!recursive || depth + 1 > maxDepth) return undefined;

  return {
    currentPath: fullPath,
    depth: depth + 1,
  };
}

function buildRegularResult(
  item: Dirent,
  fullPath: string,
  relativePath: string,
  stats: Stats,
  options: {
    recursive: boolean;
    depth: number;
    maxDepth: number;
  }
): DirectoryItemResult {
  const type = resolveEntryType(stats);

  const entry: DirectoryEntry = {
    ...buildEntryBase(item, fullPath, relativePath, type),
    size: type === 'file' ? stats.size : undefined,
    modified: stats.mtime,
  };

  const enqueueDir =
    type === 'directory'
      ? buildEnqueueDir(
          fullPath,
          options.depth,
          options.maxDepth,
          options.recursive
        )
      : undefined;

  return { entry, enqueueDir };
}

function buildFallbackEntry(
  item: Dirent,
  fullPath: string,
  relativePath: string
): DirectoryItemResult {
  const type: DirectoryEntry['type'] = item.isDirectory()
    ? 'directory'
    : item.isFile()
      ? 'file'
      : item.isSymbolicLink()
        ? 'symlink'
        : 'other';

  return {
    entry: buildEntryBase(item, fullPath, relativePath, type),
    skippedInaccessible: true,
  };
}

async function buildDirectoryItemResultCore(
  item: Dirent,
  fullPath: string,
  relativePath: string,
  options: {
    includeSymlinkTargets: boolean;
    recursive: boolean;
    depth: number;
    maxDepth: number;
    signal?: AbortSignal;
  }
): Promise<DirectoryItemResult> {
  const stats = await withAbort(fs.lstat(fullPath), options.signal);
  if (stats.isSymbolicLink()) {
    return await buildSymlinkResult(
      item,
      fullPath,
      relativePath,
      options.includeSymlinkTargets,
      stats,
      options.signal
    );
  }

  return buildRegularResult(item, fullPath, relativePath, stats, options);
}

export async function buildDirectoryItemResult(
  item: Dirent,
  currentPath: string,
  basePath: string,
  options: {
    includeSymlinkTargets: boolean;
    recursive: boolean;
    depth: number;
    maxDepth: number;
    signal?: AbortSignal;
  }
): Promise<DirectoryItemResult> {
  const fullPath = path.join(currentPath, item.name);
  const relativePath = path.relative(basePath, fullPath) || item.name;

  try {
    return await buildDirectoryItemResultCore(
      item,
      fullPath,
      relativePath,
      options
    );
  } catch {
    return buildFallbackEntry(item, fullPath, relativePath);
  }
}
