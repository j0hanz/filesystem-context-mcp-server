import type { Stats } from 'node:fs';

import type { SearchFilesResult, SearchResult } from '../../config/types.js';
import { globEntries } from './glob-engine.js';
import type { NormalizedOptions } from './search-files-helpers.js';

type SearchEntryType = 'directory' | 'symlink' | 'file' | 'other';

interface SearchEntry {
  path: string;
  dirent: {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isFile(): boolean;
  };
  stats?: Stats;
}

interface CollectState {
  results: SearchResult[];
  filesScanned: number;
  truncated: boolean;
  stoppedReason?: SearchFilesResult['summary']['stoppedReason'];
}

function resolveEntryType(dirent: SearchEntry['dirent']): SearchEntryType {
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isSymbolicLink()) return 'symlink';
  if (dirent.isFile()) return 'file';
  return 'other';
}

function buildSearchResult(
  entry: { path: string; stats?: Stats },
  entryType: SearchEntryType,
  needsStats: boolean
): SearchResult {
  let resolvedType: SearchResult['type'] = 'other';
  if (entryType === 'directory') {
    resolvedType = 'directory';
  } else if (entryType === 'file') {
    resolvedType = 'file';
  }
  const size =
    needsStats && entry.stats?.isFile() ? entry.stats.size : undefined;
  const modified = needsStats ? entry.stats?.mtime : undefined;
  return {
    path: entry.path,
    type: resolvedType,
    ...(size !== undefined ? { size } : {}),
    ...(modified !== undefined ? { modified } : {}),
  };
}

function needsStatsForSort(sortBy: NormalizedOptions['sortBy']): boolean {
  return sortBy === 'size' || sortBy === 'modified';
}

function markStopped(
  state: CollectState,
  reason: SearchFilesResult['summary']['stoppedReason']
): void {
  state.truncated = true;
  state.stoppedReason = reason;
}

function shouldStopCollecting(
  state: CollectState,
  normalized: NormalizedOptions,
  signal: AbortSignal
): boolean {
  if (signal.aborted) {
    markStopped(state, 'timeout');
    return true;
  }
  if (state.filesScanned >= normalized.maxFilesScanned) {
    markStopped(state, 'maxFiles');
    return true;
  }
  return false;
}

function shouldIncludeEntry(
  entryType: SearchEntryType,
  normalized: NormalizedOptions
): boolean {
  return !normalized.skipSymlinks || entryType !== 'symlink';
}

function createCollectState(): CollectState {
  return {
    results: [],
    filesScanned: 0,
    truncated: false,
  };
}

function buildSearchStream(
  root: string,
  pattern: string,
  excludePatterns: readonly string[],
  normalized: NormalizedOptions,
  needsStats: boolean
): AsyncIterable<SearchEntry> {
  const options: Parameters<typeof globEntries>[0] = {
    cwd: root,
    pattern,
    excludePatterns,
    includeHidden: normalized.includeHidden,
    baseNameMatch: normalized.baseNameMatch,
    caseSensitiveMatch: true,
    followSymbolicLinks: false,
    onlyFiles: true,
    stats: needsStats,
  };
  if (normalized.maxDepth !== undefined) {
    options.maxDepth = normalized.maxDepth;
  }
  return globEntries(options);
}

function buildCollectResult(state: CollectState): {
  results: SearchResult[];
  filesScanned: number;
  truncated: boolean;
  stoppedReason?: SearchFilesResult['summary']['stoppedReason'];
} {
  const baseResult = {
    results: state.results,
    filesScanned: state.filesScanned,
    truncated: state.truncated,
  };
  return {
    ...baseResult,
    ...(state.stoppedReason !== undefined
      ? { stoppedReason: state.stoppedReason }
      : {}),
  };
}

function handleEntry(
  entry: SearchEntry,
  entryType: SearchEntryType,
  needsStats: boolean,
  normalized: NormalizedOptions,
  state: CollectState
): void {
  if (!shouldIncludeEntry(entryType, normalized)) return;
  state.results.push(buildSearchResult(entry, entryType, needsStats));
  if (state.results.length >= normalized.maxResults) {
    markStopped(state, 'maxResults');
  }
}

async function collectFromStream(
  stream: AsyncIterable<SearchEntry>,
  normalized: NormalizedOptions,
  needsStats: boolean,
  state: CollectState,
  signal: AbortSignal
): Promise<void> {
  for await (const entry of stream) {
    if (shouldStopCollecting(state, normalized, signal)) break;
    state.filesScanned++;
    handleEntry(
      entry,
      resolveEntryType(entry.dirent),
      needsStats,
      normalized,
      state
    );
    if (state.truncated) break;
  }
}

export async function collectSearchResults(
  root: string,
  pattern: string,
  excludePatterns: readonly string[],
  normalized: NormalizedOptions,
  signal: AbortSignal
): Promise<{
  results: SearchResult[];
  filesScanned: number;
  truncated: boolean;
  stoppedReason?: SearchFilesResult['summary']['stoppedReason'];
}> {
  const needsStats = needsStatsForSort(normalized.sortBy);
  const stream = buildSearchStream(
    root,
    pattern,
    excludePatterns,
    normalized,
    needsStats
  );
  const state = createCollectState();
  await collectFromStream(stream, normalized, needsStats, state, signal);
  return buildCollectResult(state);
}

export function buildSearchSummary(
  results: SearchResult[],
  filesScanned: number,
  truncated: boolean,
  stoppedReason: SearchFilesResult['summary']['stoppedReason'] | undefined
): SearchFilesResult['summary'] {
  const baseSummary: SearchFilesResult['summary'] = {
    matched: results.length,
    truncated,
    skippedInaccessible: 0,
    filesScanned,
  };
  return {
    ...baseSummary,
    ...(stoppedReason !== undefined ? { stoppedReason } : {}),
  };
}
