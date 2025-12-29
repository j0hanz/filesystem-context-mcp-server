import type { Dirent } from 'node:fs';

import type { Minimatch } from 'minimatch';

import type { DirectoryEntry } from '../../config/types.js';
import { PARALLEL_CONCURRENCY } from '../constants.js';
import { processInParallel } from '../fs-helpers.js';
import {
  buildDirectoryItemResult,
  type DirectoryItemResult,
} from './list-directory-entry.js';
import { streamVisibleItems } from './list-directory-matching.js';

interface ListDirectoryState {
  entries: DirectoryEntry[];
  totalFiles: number;
  totalDirectories: number;
  maxDepthReached: number;
  truncated: boolean;
  stoppedReason?: 'maxEntries' | 'aborted';
  skippedInaccessible: number;
  symlinksNotFollowed: number;
  entriesScanned: number;
  entriesVisible: number;
}

export interface ListDirectoryConfig {
  basePath: string;
  recursive: boolean;
  includeHidden: boolean;
  excludePatterns: string[];
  excludeMatchers: Minimatch[];
  maxDepth: number;
  maxEntries?: number;
  includeSymlinkTargets: boolean;
  pattern?: string;
  patternMatcher?: Minimatch;
  signal?: AbortSignal;
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
    entriesScanned: 0,
    entriesVisible: 0,
  };
}

export function createStopChecker(
  maxEntries: number | undefined,
  state: ListDirectoryState,
  signal?: AbortSignal
): () => boolean {
  return (): boolean => {
    if (signal?.aborted) {
      state.truncated = true;
      state.stoppedReason = 'aborted';
      return true;
    }
    if (maxEntries !== undefined && state.entries.length >= maxEntries) {
      state.truncated = true;
      state.stoppedReason = 'maxEntries';
      return true;
    }
    return false;
  };
}

function applyDirectoryItemResult(
  result: DirectoryItemResult,
  state: ListDirectoryState,
  enqueue: (entry: { currentPath: string; depth: number }) => void,
  patternMatcher?: Minimatch
): void {
  const { entry, enqueueDir, skippedInaccessible, symlinkNotFollowed } = result;

  const normalizedRelative = entry.relativePath.replace(/\\/g, '/');
  if (!patternMatcher || patternMatcher.match(normalizedRelative)) {
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
  patternMatcher?: Minimatch
): void {
  for (const result of results) {
    if (shouldStop()) break;
    applyDirectoryItemResult(result, state, enqueue, patternMatcher);
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
        signal: config.signal,
      }),
    PARALLEL_CONCURRENCY,
    config.signal
  );

  state.skippedInaccessible += errors.length;
  processResults(results, state, enqueue, shouldStop, config.patternMatcher);
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
    config.excludeMatchers,
    () => {
      state.skippedInaccessible++;
    },
    () => {
      state.entriesScanned++;
    },
    () => {
      state.entriesVisible++;
    },
    config.signal
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
