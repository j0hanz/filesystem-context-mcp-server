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
    const state: SearchFilesResult['summary'] = {
      matched: 0,
      truncated: false,
      skippedInaccessible: 0,
      filesScanned: 0,
      stoppedReason: undefined,
    };

    const results: SearchResult[] = [];

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
      stats: true,
    });

    for await (const entry of stream) {
      if (signal.aborted) {
        state.truncated = true;
        state.stoppedReason = 'timeout';
        break;
      }
      if (state.filesScanned >= normalized.maxFilesScanned) {
        state.truncated = true;
        state.stoppedReason = 'maxFiles';
        break;
      }

      state.filesScanned++;

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
        size: entry.stats?.isFile() ? entry.stats.size : undefined,
        modified: entry.stats?.mtime,
      });

      if (results.length >= normalized.maxResults) {
        state.truncated = true;
        state.stoppedReason = 'maxResults';
        break;
      }
    }

    sortSearchResults(results, normalized.sortBy);
    state.matched = results.length;

    return {
      basePath: root,
      pattern,
      results,
      summary: state,
    };
  } finally {
    cleanup();
  }
}
