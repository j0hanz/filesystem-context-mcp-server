import type { SearchFilesResult } from '../../config/types.js';
import { safeDestroy } from '../fs-helpers.js';
import { validateExistingPath } from '../path-validation.js';
import { validateGlobPatternOrThrow } from './pattern-validator.js';
import {
  buildScanOptions,
  buildSearchFilesResult,
  createSearchStream,
  initSearchFilesState,
  normalizeSearchFilesOptions,
  scanStream,
  type SearchFilesOptions,
} from './search-files-helpers.js';

export async function searchFiles(
  basePath: string,
  pattern: string,
  excludePatterns: string[] = [],
  options: SearchFilesOptions = {}
): Promise<SearchFilesResult> {
  const validPath = await validateExistingPath(basePath);

  // Validate pattern
  validateGlobPatternOrThrow(pattern, validPath);

  const normalized = normalizeSearchFilesOptions(options);

  const state = initSearchFilesState();
  const stream = createSearchStream(
    validPath,
    pattern,
    excludePatterns,
    normalized.maxDepth,
    normalized.baseNameMatch,
    normalized.skipSymlinks
  );

  try {
    await scanStream(stream, state, buildScanOptions(normalized));
  } finally {
    safeDestroy(stream);
  }

  return buildSearchFilesResult(validPath, pattern, state, normalized.sortBy);
}
