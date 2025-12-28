import * as fs from 'node:fs/promises';

import fg from 'fast-glob';

import type { SearchFilesResult, SearchResult } from '../../config/types.js';
import { PARALLEL_CONCURRENCY } from '../constants.js';
import { getFileType, safeDestroy } from '../fs-helpers.js';
import { validateExistingPathDetailed } from '../path-validation.js';
import type { SearchFilesOptions } from './search-files-options.js';
import { sortSearchResults } from './sorting.js';

interface SearchFilesState {
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

type StreamStopReason = 'timeout' | 'abort' | null;

export function initSearchFilesState(): SearchFilesState {
  return {
    results: [],
    skippedInaccessible: 0,
    truncated: false,
    filesScanned: 0,
    stoppedReason: undefined,
  };
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Search aborted');
    error.name = 'AbortError';
    throw error;
  }
}

function shouldStopProcessing(
  state: SearchFilesState,
  options: {
    deadlineMs?: number;
    maxFilesScanned?: number;
    maxResults: number;
  }
): boolean {
  if (options.deadlineMs !== undefined && Date.now() > options.deadlineMs) {
    state.truncated = true;
    state.stoppedReason = 'timeout';
    return true;
  }
  if (
    options.maxFilesScanned !== undefined &&
    state.filesScanned >= options.maxFilesScanned
  ) {
    state.truncated = true;
    state.stoppedReason = 'maxFiles';
    return true;
  }
  if (state.results.length >= options.maxResults) {
    state.truncated = true;
    state.stoppedReason = 'maxResults';
    return true;
  }
  return false;
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
  },
  signal?: AbortSignal
): Promise<void> {
  if (batch.length === 0) return;
  assertNotAborted(signal);
  if (shouldStopProcessing(state, options)) return;

  const toProcess = batch.splice(0, batch.length);
  let cursor = 0;

  while (cursor < toProcess.length) {
    assertNotAborted(signal);
    if (shouldStopProcessing(state, options)) return;

    const remaining = options.maxResults - state.results.length;
    if (remaining <= 0) return;

    const sliceSize = Math.min(
      PARALLEL_CONCURRENCY,
      remaining,
      toProcess.length - cursor
    );
    const slice = toProcess.slice(cursor, cursor + sliceSize);
    cursor += sliceSize;

    const settled = await Promise.allSettled(
      slice.map((match) => {
        return toSearchResult(match);
      })
    );

    for (const result of settled) {
      assertNotAborted(signal);
      if (shouldStopProcessing(state, options)) break;
      recordSettledResult(state, result);
    }
  }
}

export async function scanStream(
  stream: AsyncIterable<string | Buffer>,
  state: SearchFilesState,
  options: ScanStreamOptions,
  signal?: AbortSignal
): Promise<void> {
  const batch: string[] = [];
  let stopReason: StreamStopReason = null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const destroyStream = (): void => {
    safeDestroy(stream as unknown);
  };

  const onAbort = (): void => {
    if (stopReason === null) {
      const isTimeout =
        options.deadlineMs !== undefined && Date.now() >= options.deadlineMs;
      if (isTimeout) {
        stopReason = 'timeout';
        state.truncated = true;
        state.stoppedReason = 'timeout';
      } else {
        stopReason = 'abort';
      }
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    destroyStream();
  };

  if (signal?.aborted) {
    onAbort();
  } else if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  if (options.deadlineMs !== undefined) {
    const delay = Math.max(0, options.deadlineMs - Date.now());
    timeoutId = setTimeout(() => {
      if (stopReason === 'abort') return;
      stopReason = 'timeout';
      state.truncated = true;
      state.stoppedReason = 'timeout';
      destroyStream();
    }, delay);
  }

  try {
    for await (const entry of stream) {
      assertNotAborted(signal);
      if (shouldStopProcessing(state, options)) break;
      const stop = await handleStreamEntry(
        entry,
        state,
        options,
        batch,
        signal
      );
      if (stop) break;
    }

    if (!state.truncated) {
      await processBatch(batch, state, options, signal);
    }
  } catch (error) {
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
      return;
    }
    if (signal?.aborted) {
      const abortError = new Error('Search aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }
    throw error;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (timeoutId) clearTimeout(timeoutId);
  }

  if (signal?.aborted) {
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
      return;
    }
    const abortError = new Error('Search aborted');
    abortError.name = 'AbortError';
    throw abortError;
  }
}

async function handleStreamEntry(
  entry: string | Buffer,
  state: SearchFilesState,
  options: ScanStreamOptions,
  batch: string[],
  signal?: AbortSignal
): Promise<boolean> {
  assertNotAborted(signal);
  const matchPath = typeof entry === 'string' ? entry : String(entry);
  state.filesScanned++;
  if (shouldStopProcessing(state, options)) return true;

  batch.push(matchPath);
  if (batch.length >= PARALLEL_CONCURRENCY) {
    await processBatch(batch, state, options, signal);
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
