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
  const stream = globEntries({
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
  const results: SearchResult[] = [];
  let filesScanned = 0;
  let truncated = false;
  let stoppedReason: SearchFilesResult['summary']['stoppedReason'];

  for await (const entry of stream) {
    if (signal.aborted) {
      truncated = true;
      stoppedReason = 'timeout';
      break;
    }
    if (filesScanned >= normalized.maxFilesScanned) {
      truncated = true;
      stoppedReason = 'maxFiles';
      break;
    }

    filesScanned++;
    const entryType = resolveEntryType(entry.dirent);
    if (!(normalized.skipSymlinks && entryType === 'symlink')) {
      results.push(buildSearchResult(entry, entryType, needsStats));
      if (results.length >= normalized.maxResults) {
        truncated = true;
        stoppedReason = 'maxResults';
        break;
      }
    }
  }

  return { results, filesScanned, truncated, stoppedReason };
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
