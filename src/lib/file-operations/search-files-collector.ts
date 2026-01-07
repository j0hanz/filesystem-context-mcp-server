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
  return {
    path: entry.path,
    type: resolvedType,
    size: needsStats && entry.stats?.isFile() ? entry.stats.size : undefined,
    modified: needsStats ? entry.stats?.mtime : undefined,
  };
}

function needsStatsForSort(sortBy: NormalizedOptions['sortBy']): boolean {
  return sortBy === 'size' || sortBy === 'modified';
}

function shouldSkipEntry(
  entryType: SearchEntryType,
  normalized: NormalizedOptions
): boolean {
  return normalized.skipSymlinks && entryType === 'symlink';
}

function createSearchStream(
  root: string,
  pattern: string,
  excludePatterns: readonly string[],
  normalized: NormalizedOptions,
  needsStats: boolean
): AsyncIterable<SearchEntry> {
  return globEntries({
    cwd: root,
    pattern,
    excludePatterns,
    includeHidden: normalized.includeHidden,
    baseNameMatch: normalized.baseNameMatch,
    caseSensitiveMatch: true,
    maxDepth: normalized.maxDepth,
    followSymbolicLinks: false,
    onlyFiles: true,
    stats: needsStats,
  });
}

interface SearchState {
  results: SearchResult[];
  filesScanned: number;
  truncated: boolean;
  stoppedReason: SearchFilesResult['summary']['stoppedReason'];
}

function createSearchState(): SearchState {
  return {
    results: [],
    filesScanned: 0,
    truncated: false,
    stoppedReason: undefined,
  };
}

function markStopped(
  state: SearchState,
  reason: SearchFilesResult['summary']['stoppedReason']
): void {
  state.truncated = true;
  state.stoppedReason = reason;
}

function resolveStopReason(
  state: SearchState,
  normalized: NormalizedOptions,
  signal: AbortSignal
): SearchFilesResult['summary']['stoppedReason'] | undefined {
  if (signal.aborted) return 'timeout';
  if (state.filesScanned >= normalized.maxFilesScanned) return 'maxFiles';
  return undefined;
}

function processEntry(
  state: SearchState,
  entry: SearchEntry,
  normalized: NormalizedOptions,
  needsStats: boolean
): void {
  state.filesScanned++;
  const entryType = resolveEntryType(entry.dirent);
  if (shouldSkipEntry(entryType, normalized)) return;
  state.results.push(buildSearchResult(entry, entryType, needsStats));
}

function shouldStopBeforeEntry(
  state: SearchState,
  normalized: NormalizedOptions,
  signal: AbortSignal
): boolean {
  const stopReason = resolveStopReason(state, normalized, signal);
  if (!stopReason) return false;
  markStopped(state, stopReason);
  return true;
}

function shouldStopAfterEntry(
  state: SearchState,
  normalized: NormalizedOptions
): boolean {
  if (state.results.length < normalized.maxResults) return false;
  markStopped(state, 'maxResults');
  return true;
}

function buildSearchResults(state: SearchState): {
  results: SearchResult[];
  filesScanned: number;
  truncated: boolean;
  stoppedReason: SearchFilesResult['summary']['stoppedReason'];
} {
  return {
    results: state.results,
    filesScanned: state.filesScanned,
    truncated: state.truncated,
    stoppedReason: state.stoppedReason,
  };
}

async function readSearchResults(
  stream: AsyncIterable<SearchEntry>,
  normalized: NormalizedOptions,
  needsStats: boolean,
  signal: AbortSignal
): Promise<{
  results: SearchResult[];
  filesScanned: number;
  truncated: boolean;
  stoppedReason: SearchFilesResult['summary']['stoppedReason'];
}> {
  const state = createSearchState();

  for await (const entry of stream) {
    if (shouldStopBeforeEntry(state, normalized, signal)) break;
    processEntry(state, entry, normalized, needsStats);
    if (shouldStopAfterEntry(state, normalized)) break;
  }

  return buildSearchResults(state);
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
  stoppedReason: SearchFilesResult['summary']['stoppedReason'];
}> {
  const needsStats = needsStatsForSort(normalized.sortBy);
  const stream = createSearchStream(
    root,
    pattern,
    excludePatterns,
    normalized,
    needsStats
  );
  return await readSearchResults(stream, normalized, needsStats, signal);
}

export function buildSearchSummary(
  results: SearchResult[],
  filesScanned: number,
  truncated: boolean,
  stoppedReason: SearchFilesResult['summary']['stoppedReason']
): SearchFilesResult['summary'] {
  return {
    matched: results.length,
    truncated,
    skippedInaccessible: 0,
    filesScanned,
    stoppedReason,
  };
}
