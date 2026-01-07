import type { SearchFilesResult, SearchResult } from '../../config/types.js';
import { createTimedAbortSignal } from '../fs-helpers/abort.js';
import { validateExistingDirectory } from '../path-validation.js';
import {
  buildSearchSummary,
  collectSearchResults,
} from './search-files-collector.js';
import {
  type NormalizedOptions,
  normalizeOptions,
  type SearchFilesOptions,
} from './search-files-helpers.js';
import { sortSearchResults } from './sorting.js';

export type { SearchFilesOptions } from './search-files-helpers.js';

async function runSearchFiles(
  root: string,
  pattern: string,
  excludePatterns: readonly string[],
  normalized: NormalizedOptions,
  signal: AbortSignal
): Promise<{ results: SearchResult[]; summary: SearchFilesResult['summary'] }> {
  const { results, filesScanned, truncated, stoppedReason } =
    await collectSearchResults(
      root,
      pattern,
      excludePatterns,
      normalized,
      signal
    );

  sortSearchResults(results, normalized.sortBy);

  return {
    results,
    summary: buildSearchSummary(
      results,
      filesScanned,
      truncated,
      stoppedReason
    ),
  };
}

export async function searchFiles(
  basePath: string,
  pattern: string,
  excludePatterns: readonly string[] = [],
  options: SearchFilesOptions = {}
): Promise<SearchFilesResult> {
  const normalized = normalizeOptions(options);
  const { signal, cleanup } = createTimedAbortSignal(
    options.signal,
    normalized.timeoutMs
  );
  const root = await validateExistingDirectory(basePath, signal);

  try {
    const { results, summary } = await runSearchFiles(
      root,
      pattern,
      excludePatterns,
      normalized,
      signal
    );

    return {
      basePath: root,
      pattern,
      results,
      summary,
    };
  } finally {
    cleanup();
  }
}
