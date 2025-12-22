import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent, Stats } from 'node:fs';

import type { DirectoryEntry } from '../../config/types.js';
import { PARALLEL_CONCURRENCY } from '../constants.js';
import { isHidden, processInParallel } from '../fs-helpers.js';
import { validateExistingPath } from '../path-validation.js';

interface ListDirectoryState {
  entries: DirectoryEntry[];
  totalFiles: number;
  totalDirectories: number;
  maxDepthReached: number;
  truncated: boolean;
  skippedInaccessible: number;
  symlinksNotFollowed: number;
}

export interface ListDirectoryConfig {
  basePath: string;
  recursive: boolean;
  includeHidden: boolean;
  maxDepth: number;
  maxEntries?: number;
  includeSymlinkTargets: boolean;
}

export function initListState(): ListDirectoryState {
  return {
    entries: [],
    totalFiles: 0,
    totalDirectories: 0,
    maxDepthReached: 0,
    truncated: false,
    skippedInaccessible: 0,
    symlinksNotFollowed: 0,
  };
}

interface DirectoryItemResult {
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

function resolveEntryType(item: Dirent, stats: Stats): DirectoryEntry['type'] {
  if (item.isDirectory()) return 'directory';
  if (item.isFile()) return 'file';
  return stats.isSymbolicLink() ? 'symlink' : 'other';
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
  options: {
    includeSymlinkTargets: boolean;
    recursive: boolean;
    depth: number;
    maxDepth: number;
    basePath: string;
  }
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
  const type: DirectoryEntry['type'] = item.isDirectory()
    ? 'directory'
    : item.isFile()
      ? 'file'
      : 'other';

  return {
    entry: buildEntryBase(item, fullPath, relativePath, type),
    skippedInaccessible: true,
  };
}

async function buildDirectoryItemResult(
  item: Dirent,
  currentPath: string,
  basePath: string,
  options: {
    includeSymlinkTargets: boolean;
    recursive: boolean;
    depth: number;
    maxDepth: number;
  }
): Promise<DirectoryItemResult> {
  const fullPath = path.join(currentPath, item.name);
  const relativePath = path.relative(basePath, fullPath) || item.name;

  try {
    return await buildDirectoryItemResultCore(item, fullPath, relativePath, {
      ...options,
      basePath,
    });
  } catch {
    return buildFallbackEntry(item, fullPath, relativePath);
  }
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
    basePath: string;
  }
): Promise<DirectoryItemResult> {
  if (item.isSymbolicLink()) {
    return await buildSymlinkResult(
      item,
      fullPath,
      relativePath,
      options.includeSymlinkTargets
    );
  }

  return await buildRegularResult(item, fullPath, relativePath, options);
}

export function createStopChecker(
  maxEntries: number | undefined,
  state: ListDirectoryState
): () => boolean {
  return (): boolean => {
    if (maxEntries !== undefined && state.entries.length >= maxEntries) {
      state.truncated = true;
      return true;
    }
    return false;
  };
}

async function readVisibleItems(
  currentPath: string,
  includeHidden: boolean
): Promise<Dirent[] | null> {
  try {
    const items = await fs.readdir(currentPath, { withFileTypes: true });
    return includeHidden ? items : items.filter((item) => !isHidden(item.name));
  } catch {
    return null;
  }
}

function applyDirectoryItemResult(
  result: DirectoryItemResult,
  state: ListDirectoryState,
  enqueue: (entry: { currentPath: string; depth: number }) => void
): void {
  const { entry, enqueueDir, skippedInaccessible, symlinkNotFollowed } = result;

  state.entries.push(entry);
  applyEntryCounts(entry, state);
  enqueueDirectory(enqueueDir, enqueue);
  applyResultFlags(state, skippedInaccessible, symlinkNotFollowed);
}

function applyEntryCounts(
  entry: DirectoryEntry,
  state: ListDirectoryState
): void {
  if (entry.type === 'directory') state.totalDirectories++;
  if (entry.type === 'file') state.totalFiles++;
}

function enqueueDirectory(
  enqueueDir: { currentPath: string; depth: number } | undefined,
  enqueue: (entry: { currentPath: string; depth: number }) => void
): void {
  if (enqueueDir) enqueue(enqueueDir);
}

function applyResultFlags(
  state: ListDirectoryState,
  skippedInaccessible: boolean | undefined,
  symlinkNotFollowed: boolean | undefined
): void {
  if (skippedInaccessible) state.skippedInaccessible++;
  if (symlinkNotFollowed) state.symlinksNotFollowed++;
}

function processResults(
  results: DirectoryItemResult[],
  state: ListDirectoryState,
  enqueue: (entry: { currentPath: string; depth: number }) => void,
  shouldStop: () => boolean
): void {
  for (const result of results) {
    if (shouldStop()) break;
    applyDirectoryItemResult(result, state, enqueue);
  }
}

export async function handleDirectory(
  params: { currentPath: string; depth: number },
  enqueue: (entry: { currentPath: string; depth: number }) => void,
  config: ListDirectoryConfig,
  state: ListDirectoryState,
  shouldStop: () => boolean
): Promise<void> {
  if (params.depth > config.maxDepth) return;
  if (shouldStop()) return;

  state.maxDepthReached = Math.max(state.maxDepthReached, params.depth);

  const items = await readVisibleItems(
    params.currentPath,
    config.includeHidden
  );
  if (!items) {
    state.skippedInaccessible++;
    return;
  }

  const { results, errors } = await processInParallel(
    items,
    async (item) =>
      buildDirectoryItemResult(item, params.currentPath, config.basePath, {
        includeSymlinkTargets: config.includeSymlinkTargets,
        recursive: config.recursive,
        depth: params.depth,
        maxDepth: config.maxDepth,
      }),
    PARALLEL_CONCURRENCY
  );

  state.skippedInaccessible += errors.length;
  processResults(results, state, enqueue, shouldStop);
}
