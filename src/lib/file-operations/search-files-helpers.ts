import * as fs from 'node:fs/promises';

import fg from 'fast-glob';

import type { SearchFilesResult, SearchResult } from '../../config/types.js';
import { PARALLEL_CONCURRENCY } from '../constants.js';
import { getFileType } from '../fs-helpers.js';
import { validateExistingPathDetailed } from '../path-validation.js';
import type { SearchFilesOptions } from './search-files-options.js';
import { sortSearchResults } from './sorting.js';

export interface SearchFilesState {
  results: SearchResult[];
  skippedInaccessible: number;
  truncated: boolean;
  filesScanned: number;
  stoppedReason?: SearchFilesResult['summary']['stoppedReason'];
}

interface ScanStreamOptions {
  deadlineMs?: number;
  maxFilesScanned?: number;
  maxResults: number;
}

type SearchStopReason = SearchFilesResult['summary']['stoppedReason'];

export function initSearchFilesState(): SearchFilesState {
  return {
    results: [],
    skippedInaccessible: 0,
    truncated: false,
    filesScanned: 0,
    stoppedReason: undefined,
  };
}

function markTruncated(
  state: SearchFilesState,
  reason: SearchStopReason
): void {
  state.truncated = true;
  state.stoppedReason = reason;
}

function getDeadlineStopReason(options: {
  deadlineMs?: number;
}): SearchStopReason | undefined {
  if (options.deadlineMs !== undefined && Date.now() > options.deadlineMs) {
    return 'timeout';
  }
  return undefined;
}

function getMaxFilesStopReason(
  state: SearchFilesState,
  options: { maxFilesScanned?: number }
): SearchStopReason | undefined {
  if (
    options.maxFilesScanned !== undefined &&
    state.filesScanned >= options.maxFilesScanned
  ) {
    return 'maxFiles';
  }
  return undefined;
}

function getMaxResultsStopReason(
  state: SearchFilesState,
  options: { maxResults: number }
): SearchStopReason | undefined {
  if (state.results.length >= options.maxResults) {
    return 'maxResults';
  }
  return undefined;
}

function getStopReason(
  state: SearchFilesState,
  options: {
    deadlineMs?: number;
    maxFilesScanned?: number;
    maxResults: number;
  }
): SearchStopReason | undefined {
  return (
    getDeadlineStopReason(options) ??
    getMaxFilesStopReason(state, options) ??
    getMaxResultsStopReason(state, options)
  );
}

function applyStopIfNeeded(
  state: SearchFilesState,
  reason: SearchStopReason | undefined
): boolean {
  if (!reason) return false;
  markTruncated(state, reason);
  return true;
}

function shouldStopProcessing(
  state: SearchFilesState,
  options: {
    deadlineMs?: number;
    maxFilesScanned?: number;
    maxResults: number;
  }
): boolean {
  return applyStopIfNeeded(state, getStopReason(state, options));
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

function recordSettledResult(
  state: SearchFilesState,
  result: PromiseSettledResult<SearchResult | { error: Error }>
): void {
  if (result.status === 'fulfilled') {
    if ('error' in result.value) {
      state.skippedInaccessible++;
      return;
    }
    state.results.push(result.value);
    return;
  }

  state.skippedInaccessible++;
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
  if (shouldStopProcessing(state, options)) return;

  const toProcess = batch.splice(0, batch.length);
  const settled = await Promise.allSettled(
    toProcess.map(async (match) => toSearchResult(match))
  );

  for (const result of settled) {
    if (shouldStopProcessing(state, options)) break;
    recordSettledResult(state, result);
  }
}

export async function scanStream(
  stream: AsyncIterable<string | Buffer>,
  state: SearchFilesState,
  options: ScanStreamOptions
): Promise<void> {
  const batch: string[] = [];

  for await (const entry of stream) {
    if (shouldStopProcessing(state, options)) break;
    const stop = await handleStreamEntry(entry, state, options, batch);
    if (stop) break;
  }

  if (!state.truncated) {
    await processBatch(batch, state, options);
  }
}

async function handleStreamEntry(
  entry: string | Buffer,
  state: SearchFilesState,
  options: ScanStreamOptions,
  batch: string[]
): Promise<boolean> {
  const matchPath = typeof entry === 'string' ? entry : String(entry);
  state.filesScanned++;
  if (shouldStopProcessing(state, options)) return true;

  batch.push(matchPath);
  if (batch.length >= PARALLEL_CONCURRENCY) {
    await processBatch(batch, state, options);
  }

  return false;
}

export function createSearchStream(
  basePath: string,
  pattern: string,
  excludePatterns: string[],
  maxDepth: number | undefined,
  baseNameMatch = false,
  skipSymlinks = true,
  includeHidden = false
): AsyncIterable<string | Buffer> {
  return fg.stream(pattern, {
    cwd: basePath,
    absolute: true,
    onlyFiles: true,
    dot: includeHidden,
    ignore: excludePatterns,
    suppressErrors: true,
    followSymbolicLinks: !skipSymlinks,
    deep: maxDepth,
    baseNameMatch,
  });
}

export function buildSearchFilesResult(
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
