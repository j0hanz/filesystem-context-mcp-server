import * as fs from 'node:fs/promises';

import type { SearchResult } from '../../config/types.js';
import { PARALLEL_CONCURRENCY } from '../constants.js';
import { getFileType } from '../fs-helpers.js';
import { withAbort } from '../fs-helpers/abort.js';
import { validateExistingPathDetailed } from '../path-validation.js';
import type { ScanStreamOptions } from './search-files-stream.js';
import type { SearchFilesState } from './search-files.js';

function createAbortError(): Error {
  const error = new Error('Search aborted');
  error.name = 'AbortError';
  return error;
}

export function markStopped(
  state: SearchFilesState,
  reason: SearchFilesState['stoppedReason']
): void {
  state.truncated = true;
  state.stoppedReason = reason;
}

function stopDueToDeadline(
  state: SearchFilesState,
  deadlineMs: number | undefined
): boolean {
  if (deadlineMs === undefined) return false;
  if (Date.now() <= deadlineMs) return false;
  markStopped(state, 'timeout');
  return true;
}

function stopDueToMaxFiles(
  state: SearchFilesState,
  maxFilesScanned: number | undefined
): boolean {
  if (maxFilesScanned === undefined) return false;
  if (state.filesScanned <= maxFilesScanned) return false;
  markStopped(state, 'maxFiles');
  return true;
}

function stopDueToMaxResults(
  state: SearchFilesState,
  maxResults: number
): boolean {
  if (state.results.length < maxResults) return false;
  markStopped(state, 'maxResults');
  return true;
}

function shouldStopProcessing(
  state: SearchFilesState,
  options: ScanStreamOptions
): boolean {
  if (stopDueToDeadline(state, options.deadlineMs)) return true;
  if (stopDueToMaxFiles(state, options.maxFilesScanned)) return true;
  if (stopDueToMaxResults(state, options.maxResults)) return true;
  return false;
}

function shouldAbortOrStop(
  signal: AbortSignal | undefined,
  state: SearchFilesState,
  options: ScanStreamOptions
): boolean {
  if (signal?.aborted) return true;
  return shouldStopProcessing(state, options);
}

async function toSearchResult(
  match: string,
  signal?: AbortSignal
): Promise<SearchResult | { error: Error }> {
  try {
    const { requestedPath, resolvedPath, isSymlink } =
      await validateExistingPathDetailed(match, signal);
    const stats = await withAbort(fs.stat(resolvedPath), signal);
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
  if (result.status !== 'fulfilled') {
    state.skippedInaccessible++;
    return;
  }
  if ('error' in result.value) {
    state.skippedInaccessible++;
    return;
  }
  state.results.push(result.value);
}

function sliceBatch(
  values: string[],
  cursor: number,
  remaining: number
): { slice: string[]; nextCursor: number } {
  const sliceSize = Math.min(
    PARALLEL_CONCURRENCY,
    remaining,
    values.length - cursor
  );
  return {
    slice: values.slice(cursor, cursor + sliceSize),
    nextCursor: cursor + sliceSize,
  };
}

function getRemainingResults(
  state: SearchFilesState,
  maxResults: number
): number {
  return maxResults - state.results.length;
}

async function processSlice(
  slice: string[],
  state: SearchFilesState,
  options: ScanStreamOptions,
  signal?: AbortSignal
): Promise<boolean> {
  const settled = await Promise.allSettled(
    slice.map((match) => {
      return toSearchResult(match, signal);
    })
  );

  for (const result of settled) {
    if (signal?.aborted) throw createAbortError();
    if (shouldStopProcessing(state, options)) return true;
    recordSettledResult(state, result);
  }

  return false;
}

async function processBatchSlice(
  toProcess: string[],
  cursor: number,
  state: SearchFilesState,
  options: ScanStreamOptions,
  signal?: AbortSignal
): Promise<number | undefined> {
  if (shouldAbortOrStop(signal, state, options)) return undefined;

  const remaining = getRemainingResults(state, options.maxResults);
  if (remaining <= 0) return undefined;

  const { slice, nextCursor } = sliceBatch(toProcess, cursor, remaining);
  const shouldStop = await processSlice(slice, state, options, signal);
  return shouldStop ? undefined : nextCursor;
}

async function processBatch(
  batch: string[],
  state: SearchFilesState,
  options: ScanStreamOptions,
  signal?: AbortSignal
): Promise<void> {
  if (batch.length === 0) return;
  if (shouldAbortOrStop(signal, state, options)) return;

  const toProcess = batch.splice(0, batch.length);
  let cursor = 0;

  while (cursor < toProcess.length) {
    const nextCursor = await processBatchSlice(
      toProcess,
      cursor,
      state,
      options,
      signal
    );
    if (nextCursor === undefined) return;
    cursor = nextCursor;
  }
}

async function handleStreamEntry(
  entry: string | Buffer,
  state: SearchFilesState,
  options: ScanStreamOptions,
  batch: string[],
  signal?: AbortSignal
): Promise<boolean> {
  if (shouldAbortOrStop(signal, state, options)) return false;

  if (
    options.maxFilesScanned !== undefined &&
    state.filesScanned >= options.maxFilesScanned
  ) {
    markStopped(state, 'maxFiles');
    return false;
  }

  const matchPath = typeof entry === 'string' ? entry : String(entry);
  state.filesScanned += 1;
  if (shouldStopProcessing(state, options)) return false;

  batch.push(matchPath);
  if (batch.length >= PARALLEL_CONCURRENCY) {
    await processBatch(batch, state, options, signal);
  }

  return true;
}

async function processStreamEntries(
  stream: AsyncIterable<string | Buffer>,
  state: SearchFilesState,
  options: ScanStreamOptions,
  batch: string[],
  signal?: AbortSignal
): Promise<void> {
  for await (const entry of stream) {
    const shouldContinue = await handleStreamEntry(
      entry,
      state,
      options,
      batch,
      signal
    );
    if (!shouldContinue) break;
  }
}

export function handleScanError(
  error: unknown,
  options: ScanStreamOptions,
  signal?: AbortSignal
): void {
  if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
    return;
  }
  if (signal?.aborted) {
    throw createAbortError();
  }
  throw error;
}

export function throwIfAborted(
  signal: AbortSignal | undefined,
  deadlineMs: number | undefined
): void {
  if (!signal?.aborted) return;
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) return;
  throw createAbortError();
}

export async function drainStream(
  stream: AsyncIterable<string | Buffer>,
  state: SearchFilesState,
  options: ScanStreamOptions,
  batch: string[],
  signal?: AbortSignal
): Promise<void> {
  await processStreamEntries(stream, state, options, batch, signal);
  if (!state.truncated || state.stoppedReason === 'maxFiles') {
    await processBatch(batch, state, options, signal);
  }
}
