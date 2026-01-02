import type { SearchFilesResult, SearchResult } from '../../config/types.js';
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from '../constants.js';
import { createTimedAbortSignal } from '../fs-helpers/abort.js';
import { validateExistingDirectory } from '../path-validation.js';
import { globEntries } from './glob-engine.js';
import { sortSearchResults } from './sorting.js';

export interface SearchFilesOptions {
  maxResults?: number;
  sortBy?: 'name' | 'size' | 'modified' | 'path';
  maxDepth?: number;
  maxFilesScanned?: number;
  timeoutMs?: number;
  baseNameMatch?: boolean;
  skipSymlinks?: boolean;
  includeHidden?: boolean;
  signal?: AbortSignal;
}

type NormalizedOptions = Required<
  Omit<SearchFilesOptions, 'maxDepth' | 'sortBy' | 'signal'>
> & {
  maxDepth?: number;
  sortBy: NonNullable<SearchFilesOptions['sortBy']>;
};

function normalizeOptions(options: SearchFilesOptions): NormalizedOptions {
  return {
    maxResults: options.maxResults ?? DEFAULT_MAX_RESULTS,
    sortBy: options.sortBy ?? 'path',
    maxDepth: options.maxDepth,
    maxFilesScanned: options.maxFilesScanned ?? DEFAULT_SEARCH_MAX_FILES,
    timeoutMs: options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    baseNameMatch: options.baseNameMatch ?? false,
    skipSymlinks: options.skipSymlinks ?? true,
    includeHidden: options.includeHidden ?? false,
  };
}

export async function searchFiles(
  basePath: string,
  pattern: string,
  excludePatterns: string[] = [],
  options: SearchFilesOptions = {}
): Promise<SearchFilesResult> {
  const normalized = normalizeOptions(options);
  const { signal, cleanup } = createTimedAbortSignal(
    options.signal,
    normalized.timeoutMs
  );
  const root = await validateExistingDirectory(basePath, signal);

  try {
    const needsStats =
      normalized.sortBy === 'size' || normalized.sortBy === 'modified';

    const results: SearchResult[] = [];
    let filesScanned = 0;
    let truncated = false;
    let stoppedReason: SearchFilesResult['summary']['stoppedReason'];
    const skippedInaccessible = 0;

    const stream = globEntries({
      cwd: root,
      pattern,
      excludePatterns,
      includeHidden: normalized.includeHidden,
      baseNameMatch: normalized.baseNameMatch,
      caseSensitiveMatch: true,
      maxDepth: normalized.maxDepth,
      followSymbolicLinks: false,
      onlyFiles: false,
      stats: needsStats,
    });

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

      const type = entry.dirent.isDirectory()
        ? 'directory'
        : entry.dirent.isSymbolicLink()
          ? 'symlink'
          : entry.dirent.isFile()
            ? 'file'
            : 'other';

      if (normalized.skipSymlinks && type === 'symlink') {
        continue;
      }

      results.push({
        path: entry.path,
        type:
          type === 'directory'
            ? 'directory'
            : type === 'file'
              ? 'file'
              : 'other',
        size:
          needsStats && entry.stats?.isFile() ? entry.stats.size : undefined,
        modified: needsStats ? entry.stats?.mtime : undefined,
      });

      if (results.length >= normalized.maxResults) {
        truncated = true;
        stoppedReason = 'maxResults';
        break;
      }
    }

    sortSearchResults(results, normalized.sortBy);

    return {
      basePath: root,
      pattern,
      results,
      summary: {
        matched: results.length,
        truncated,
        skippedInaccessible,
        filesScanned,
        stoppedReason,
      },
    };
  } finally {
    cleanup();
  }
}
