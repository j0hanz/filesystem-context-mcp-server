import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dir, Dirent } from 'node:fs';

import { minimatch } from 'minimatch';

import type { DirectoryEntry } from '../../config/types.js';
import { PARALLEL_CONCURRENCY } from '../constants.js';
import { isHidden, processInParallel } from '../fs-helpers.js';
import {
  buildDirectoryItemResult,
  type DirectoryItemResult,
} from './list-directory-entry.js';

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
  excludePatterns: string[];
  maxDepth: number;
  maxEntries?: number;
  includeSymlinkTargets: boolean;
  pattern?: string;
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

function shouldExcludeEntry(
  item: Dirent,
  currentPath: string,
  basePath: string,
  excludePatterns: string[]
): boolean {
  if (excludePatterns.length === 0) return false;
  const relativePath =
    path.relative(basePath, path.join(currentPath, item.name)) || item.name;
  const normalizedRelative = relativePath.replace(/\\/g, '/');
  const options = {
    dot: true,
    nocase: process.platform === 'win32',
    windowsPathsNoEscape: true,
  };
  return excludePatterns.some(
    (pattern) =>
      minimatch(item.name, pattern, options) ||
      minimatch(normalizedRelative, pattern, options)
  );
}

async function* streamVisibleItems(
  currentPath: string,
  basePath: string,
  includeHidden: boolean,
  excludePatterns: string[],
  onInaccessible: () => void
): AsyncIterable<Dirent> {
  const dir = await openDirectory(currentPath, onInaccessible);
  if (!dir) return;

  const filteredItems = filterVisibleItems(
    dir,
    currentPath,
    basePath,
    includeHidden,
    excludePatterns
  );

  try {
    for await (const item of filteredItems) {
      yield item;
    }
  } catch {
    onInaccessible();
  } finally {
    await dir.close().catch(() => {});
  }
}

async function* filterVisibleItems(
  items: AsyncIterable<Dirent>,
  currentPath: string,
  basePath: string,
  includeHidden: boolean,
  excludePatterns: string[]
): AsyncIterable<Dirent> {
  for await (const item of items) {
    if (
      shouldIncludeEntry(item, currentPath, basePath, {
        includeHidden,
        excludePatterns,
      })
    ) {
      yield item;
    }
  }
}

function shouldIncludeEntry(
  item: Dirent,
  currentPath: string,
  basePath: string,
  options: { includeHidden: boolean; excludePatterns: string[] }
): boolean {
  if (!options.includeHidden && isHidden(item.name)) return false;
  if (
    shouldExcludeEntry(item, currentPath, basePath, options.excludePatterns)
  ) {
    return false;
  }
  return true;
}

function applyDirectoryItemResult(
  result: DirectoryItemResult,
  state: ListDirectoryState,
  enqueue: (entry: { currentPath: string; depth: number }) => void,
  pattern?: string
): void {
  const { entry, enqueueDir, skippedInaccessible, symlinkNotFollowed } = result;

  if (!pattern || minimatch(entry.relativePath, pattern, { dot: true })) {
    state.entries.push(entry);
    applyEntryCounts(entry, state);
  }

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
  shouldStop: () => boolean,
  pattern?: string
): void {
  for (const result of results) {
    if (shouldStop()) break;
    applyDirectoryItemResult(result, state, enqueue, pattern);
  }
}

async function flushBatch(
  batch: Dirent[],
  params: { currentPath: string; depth: number },
  config: ListDirectoryConfig,
  state: ListDirectoryState,
  enqueue: (entry: { currentPath: string; depth: number }) => void,
  shouldStop: () => boolean
): Promise<void> {
  if (batch.length === 0) return;
  if (shouldStop()) return;

  const items = batch.splice(0, batch.length);
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
  processResults(results, state, enqueue, shouldStop, config.pattern);
}

async function processItemStream(
  itemStream: AsyncIterable<Dirent>,
  batch: Dirent[],
  params: { currentPath: string; depth: number },
  config: ListDirectoryConfig,
  state: ListDirectoryState,
  enqueue: (entry: { currentPath: string; depth: number }) => void,
  shouldStop: () => boolean
): Promise<void> {
  for await (const item of itemStream) {
    if (shouldStop()) break;
    batch.push(item);
    if (batch.length >= PARALLEL_CONCURRENCY) {
      await flushBatch(batch, params, config, state, enqueue, shouldStop);
    }
  }
}

export async function handleDirectory(
  params: { currentPath: string; depth: number },
  enqueue: (entry: { currentPath: string; depth: number }) => void,
  config: ListDirectoryConfig,
  state: ListDirectoryState,
  shouldStop: () => boolean
): Promise<void> {
  if (params.depth > config.maxDepth || shouldStop()) return;

  state.maxDepthReached = Math.max(state.maxDepthReached, params.depth);

  const itemStream = streamVisibleItems(
    params.currentPath,
    config.basePath,
    config.includeHidden,
    config.excludePatterns,
    () => {
      state.skippedInaccessible++;
    }
  );
  const batch: Dirent[] = [];
  await processItemStream(
    itemStream,
    batch,
    params,
    config,
    state,
    enqueue,
    shouldStop
  );
  await flushBatch(batch, params, config, state, enqueue, shouldStop);
}
