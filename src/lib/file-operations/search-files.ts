import * as fs from 'node:fs/promises';

import fg from 'fast-glob';

import type { SearchFilesResult, SearchResult } from '../../config/types.js';
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  PARALLEL_CONCURRENCY,
} from '../constants.js';
import { getFileType } from '../fs-helpers.js';
import {
  validateExistingPath,
  validateExistingPathDetailed,
} from '../path-validation.js';
import {
  analyzePatternComplexity,
  getComplexityWarning,
} from './pattern-complexity.js';
import { validateGlobPatternOrThrow } from './pattern-validator.js';
import { sortSearchResults } from './sorting.js';

interface SearchFilesState {
  results: SearchResult[];
  skippedInaccessible: number;
  truncated: boolean;
  filesScanned: number;
  stoppedReason?: SearchFilesResult['summary']['stoppedReason'];
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

type SearchStopReason = SearchFilesResult['summary']['stoppedReason'];

function markTruncated(
  state: SearchFilesState,
  reason: SearchStopReason
): void {
  state.truncated = true;
  state.stoppedReason = reason;
}

function getStopReason(
  state: SearchFilesState,
  options: {
    deadlineMs?: number;
    maxFilesScanned?: number;
    maxResults: number;
  }
): SearchStopReason | undefined {
  if (options.deadlineMs !== undefined && Date.now() > options.deadlineMs) {
    return 'timeout';
  }
  if (
    options.maxFilesScanned !== undefined &&
    state.filesScanned >= options.maxFilesScanned
  ) {
    return 'maxFiles';
  }
  if (state.results.length >= options.maxResults) {
    return 'maxResults';
  }
  return undefined;
}

function applyStopIfNeeded(
  state: SearchFilesState,
  reason: SearchStopReason | undefined
): boolean {
  if (!reason) return false;
  markTruncated(state, reason);
  return true;
}

async function toSearchResult(
  match: string
): Promise<SearchResult | { error: Error }> {
  try {
    const { requestedPath, resolvedPath, isSymlink } =
      await validateExistingPathDetailed(match);
    const stats = await fs.stat(resolvedPath);
    return {
      path: requestedPath,
      type: isSymlink ? 'symlink' : getFileType(stats),
      size: stats.isFile() ? stats.size : undefined,
      modified: stats.mtime,
    };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

async function processBatch(
  batch: string[],
  state: SearchFilesState,
  options: {
    deadlineMs?: number;
    maxFilesScanned?: number;
    maxResults: number;
  }
): Promise<void> {
  if (batch.length === 0) return;
  if (applyStopIfNeeded(state, getStopReason(state, options))) return;

  const toProcess = batch.splice(0, batch.length);
  const settled = await Promise.allSettled(
    toProcess.map(async (match) => toSearchResult(match))
  );

  for (const result of settled) {
    if (applyStopIfNeeded(state, getStopReason(state, options))) break;
    if (result.status === 'fulfilled') {
      if ('error' in result.value) {
        state.skippedInaccessible++;
        continue;
      }
      state.results.push(result.value);
    } else {
      state.skippedInaccessible++;
    }
  }
}

async function scanStream(
  stream: AsyncIterable<string | Buffer>,
  state: SearchFilesState,
  options: {
    deadlineMs?: number;
    maxFilesScanned?: number;
    maxResults: number;
  }
): Promise<void> {
  const batch: string[] = [];

  for await (const entry of stream) {
    if (applyStopIfNeeded(state, getStopReason(state, options))) break;
    const matchPath = typeof entry === 'string' ? entry : String(entry);
    state.filesScanned++;
    if (applyStopIfNeeded(state, getStopReason(state, options))) break;

    batch.push(matchPath);
    if (batch.length >= PARALLEL_CONCURRENCY) {
      await processBatch(batch, state, options);
    }
  }

  if (!state.truncated) {
    await processBatch(batch, state, options);
  }
}

function createSearchStream(
  basePath: string,
  pattern: string,
  excludePatterns: string[],
  maxDepth: number | undefined,
  baseNameMatch = false,
  skipSymlinks = true
): AsyncIterable<string | Buffer> {
  return fg.stream(pattern, {
    cwd: basePath,
    absolute: true,
    onlyFiles: true,
    dot: true,
    ignore: excludePatterns,
    suppressErrors: true,
    followSymbolicLinks: !skipSymlinks,
    deep: maxDepth,
    baseNameMatch,
  });
}

export async function searchFiles(
  basePath: string,
  pattern: string,
  excludePatterns: string[] = [],
  options: {
    maxResults?: number;
    sortBy?: 'name' | 'size' | 'modified' | 'path';
    maxDepth?: number;
    maxFilesScanned?: number;
    timeoutMs?: number;
    baseNameMatch?: boolean;
    skipSymlinks?: boolean;
  } = {}
): Promise<SearchFilesResult> {
  const validPath = await validateExistingPath(basePath);

  // Validate pattern
  validateGlobPatternOrThrow(pattern, validPath);

  // Analyze pattern complexity
  const complexity = analyzePatternComplexity(pattern);
  const warning = getComplexityWarning(complexity);
  if (warning) {
    console.warn(warning);
  }

  const {
    maxResults,
    sortBy = 'path',
    maxDepth,
    maxFilesScanned = DEFAULT_SEARCH_MAX_FILES,
    timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS,
    baseNameMatch,
    skipSymlinks,
  } = options;
  const effectiveMaxResults = maxResults ?? DEFAULT_MAX_RESULTS;
  const deadlineMs = timeoutMs ? Date.now() + timeoutMs : undefined;

  const state = initSearchFilesState();
  const stream = createSearchStream(
    validPath,
    pattern,
    excludePatterns,
    maxDepth,
    baseNameMatch ?? false,
    skipSymlinks ?? true
  );

  try {
    await scanStream(stream, state, {
      deadlineMs,
      maxFilesScanned,
      maxResults: effectiveMaxResults,
    });
  } finally {
    const { destroy } = stream as { destroy?: () => void };
    if (typeof destroy === 'function') destroy.call(stream);
  }

  sortSearchResults(state.results, sortBy);

  return {
    basePath: validPath,
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
