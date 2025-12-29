import type { SearchFilesResult, SearchResult } from '../../config/types.js';
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from '../constants.js';
import { ErrorCode, McpError } from '../errors.js';
import { safeDestroy } from '../fs-helpers.js';
import { mergeDefined } from '../merge-defined.js';
import { validateExistingDirectory } from '../path-validation.js';
import { validateGlobPatternOrThrow } from './pattern-validator.js';
import { createSearchStream, scanStream } from './search-files-stream.js';
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

interface NormalizedSearchFilesOptions {
  effectiveMaxResults: number;
  sortBy: 'name' | 'size' | 'modified' | 'path';
  maxDepth?: number;
  maxFilesScanned: number;
  deadlineMs?: number;
  baseNameMatch: boolean;
  skipSymlinks: boolean;
  includeHidden: boolean;
}

export interface SearchFilesState {
  results: SearchResult[];
  skippedInaccessible: number;
  truncated: boolean;
  filesScanned: number;
  stoppedReason?: SearchFilesResult['summary']['stoppedReason'];
}

function normalizeSearchFilesOptions(
  options: Omit<SearchFilesOptions, 'signal'>
): NormalizedSearchFilesOptions {
  const defaults: Required<Omit<SearchFilesOptions, 'maxDepth' | 'signal'>> & {
    maxDepth: number | undefined;
  } = {
    maxResults: DEFAULT_MAX_RESULTS,
    sortBy: 'path',
    maxDepth: undefined,
    maxFilesScanned: DEFAULT_SEARCH_MAX_FILES,
    timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
    baseNameMatch: false,
    skipSymlinks: true,
    includeHidden: false,
  };
  const merged = mergeDefined(defaults, options);
  return {
    effectiveMaxResults: merged.maxResults,
    sortBy: merged.sortBy,
    maxDepth: merged.maxDepth,
    maxFilesScanned: merged.maxFilesScanned,
    deadlineMs: merged.timeoutMs ? Date.now() + merged.timeoutMs : undefined,
    baseNameMatch: merged.baseNameMatch,
    skipSymlinks: merged.skipSymlinks,
    includeHidden: merged.includeHidden,
  };
}

function buildScanOptions(normalized: {
  deadlineMs?: number;
  maxFilesScanned: number;
  effectiveMaxResults: number;
}): {
  deadlineMs?: number;
  maxFilesScanned: number;
  maxResults: number;
} {
  return {
    deadlineMs: normalized.deadlineMs,
    maxFilesScanned: normalized.maxFilesScanned,
    maxResults: normalized.effectiveMaxResults,
  };
}

function initSearchFilesState(): SearchFilesState {
  return {
    results: [],
    skippedInaccessible: 0,
    truncated: false,
    filesScanned: 0,
    stoppedReason: undefined,
  };
}

function buildSearchFilesResult(
  basePath: string,
  pattern: string,
  state: SearchFilesState,
  sortBy: SearchFilesOptions['sortBy']
): SearchFilesResult {
  sortSearchResults(state.results, sortBy ?? 'path');
  return {
    basePath,
    pattern,
    results: state.results,
    summary: {
      matched: state.results.length,
      truncated: state.truncated,
      skippedInaccessible: state.skippedInaccessible,
      filesScanned: state.filesScanned,
      stoppedReason: state.stoppedReason,
    },
  };
}

export async function searchFiles(
  basePath: string,
  pattern: string,
  excludePatterns: string[] = [],
  options: SearchFilesOptions = {}
): Promise<SearchFilesResult> {
  const validPath = await validateExistingDirectory(basePath, options.signal);

  // Validate pattern
  validateGlobPatternOrThrow(pattern, validPath);

  const { signal, ...rest } = options;
  const normalized = normalizeSearchFilesOptions(rest);
  if (!normalized.skipSymlinks) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Following symbolic links is not supported for security reasons',
      basePath
    );
  }

  const state = initSearchFilesState();
  const stream = createSearchStream(
    validPath,
    pattern,
    excludePatterns,
    normalized.maxDepth,
    normalized.baseNameMatch,
    normalized.skipSymlinks,
    normalized.includeHidden
  );

  try {
    await scanStream(stream, state, buildScanOptions(normalized), signal);
  } finally {
    safeDestroy(stream);
  }

  return buildSearchFilesResult(validPath, pattern, state, normalized.sortBy);
}
