import fg from 'fast-glob';

import { PARALLEL_CONCURRENCY } from '../../constants.js';
import type { SearchOptions } from './engine-options.js';
import { processFile } from './file-processor.js';
import type { Matcher } from './match-strategy.js';
import type { ScanResult, SearchState } from './types.js';

interface ProcessorBaseOptions {
  maxResults: number;
  contextLines: number;
  deadlineMs?: number;
  isLiteral: boolean;
  wholeWord: boolean;
  caseSensitive: boolean;
  maxFileSize: number;
  skipBinary: boolean;
  searchPattern: string;
}

interface StreamProcessingState {
  active: Set<Promise<void>>;
  inFlight: number;
  processorBaseOptions: ProcessorBaseOptions;
}

export function createStream(
  basePath: string,
  options: SearchOptions
): AsyncIterable<string | Buffer> {
  return fg.stream(options.filePattern, {
    cwd: basePath,
    absolute: true,
    onlyFiles: true,
    dot: options.includeHidden,
    ignore: options.excludePatterns,
    suppressErrors: true,
    followSymbolicLinks: false,
    baseNameMatch: options.baseNameMatch,
    caseSensitiveMatch: options.caseSensitiveFileMatch,
  });
}

function shouldStop(
  state: SearchState,
  options: SearchOptions,
  deadlineMs?: number
): boolean {
  if (deadlineMs && Date.now() > deadlineMs) {
    state.truncated = true;
    state.stoppedReason = 'timeout';
    return true;
  }
  if (state.filesScanned >= options.maxFilesScanned) {
    state.truncated = true;
    state.stoppedReason = 'maxFiles';
    return true;
  }
  if (state.matches.length >= options.maxResults) {
    state.truncated = true;
    state.stoppedReason = 'maxResults';
    return true;
  }
  return false;
}

function updateState(state: SearchState, result: ScanResult): void {
  state.filesScanned++;
  if (!result.scanned) {
    state.skippedInaccessible++;
    return;
  }

  if (result.skippedTooLarge) state.skippedTooLarge++;
  if (result.skippedBinary) state.skippedBinary++;

  if (result.matches.length > 0) {
    state.matches.push(...result.matches);
    state.filesMatched++;
  }
  state.linesSkippedDueToRegexTimeout += result.linesSkippedDueToRegexTimeout;
}

function buildProcessorBaseOptions(
  options: SearchOptions,
  deadlineMs: number | undefined,
  searchPattern: string
): ProcessorBaseOptions {
  return {
    maxResults: options.maxResults,
    contextLines: options.contextLines,
    deadlineMs,
    isLiteral: options.isLiteral,
    wholeWord: options.wholeWord,
    caseSensitive: options.caseSensitive,
    maxFileSize: options.maxFileSize,
    skipBinary: options.skipBinary,
    searchPattern,
  };
}

async function enforceMaxFilesScanned(
  state: SearchState,
  options: SearchOptions,
  inFlight: number,
  active: Set<Promise<void>>
): Promise<'ok' | 'skip' | 'stop'> {
  if (state.filesScanned + inFlight < options.maxFilesScanned) {
    return 'ok';
  }
  if (active.size === 0) {
    return 'stop';
  }
  await Promise.race(active);
  return 'skip';
}

async function waitForConcurrency(active: Set<Promise<void>>): Promise<void> {
  while (active.size >= PARALLEL_CONCURRENCY) {
    await Promise.race(active);
  }
}

function createProcessingState(
  options: SearchOptions,
  deadlineMs: number | undefined,
  searchPattern: string
): StreamProcessingState {
  return {
    active: new Set<Promise<void>>(),
    inFlight: 0,
    processorBaseOptions: buildProcessorBaseOptions(
      options,
      deadlineMs,
      searchPattern
    ),
  };
}

async function handleStreamEntry(
  entry: string | Buffer,
  searchState: SearchState,
  processing: StreamProcessingState,
  matcher: Matcher,
  options: SearchOptions,
  deadlineMs: number | undefined
): Promise<'continue' | 'stop'> {
  if (shouldStop(searchState, options, deadlineMs)) return 'stop';
  const maxFilesAction = await enforceMaxFilesScanned(
    searchState,
    options,
    processing.inFlight,
    processing.active
  );
  if (maxFilesAction === 'stop') return 'stop';
  if (maxFilesAction === 'skip') return 'continue';
  await waitForConcurrency(processing.active);
  const rawPath = String(entry);
  const task = createProcessingTask(
    rawPath,
    searchState,
    matcher,
    processing.processorBaseOptions,
    options,
    deadlineMs
  );
  processing.inFlight++;
  processing.active.add(task);
  void task.finally(() => {
    processing.active.delete(task);
    processing.inFlight--;
  });
  return 'continue';
}

function createProcessingTask(
  rawPath: string,
  state: SearchState,
  matcher: Matcher,
  processorBaseOptions: ProcessorBaseOptions,
  options: SearchOptions,
  deadlineMs: number | undefined
): Promise<void> {
  return (async (): Promise<void> => {
    try {
      if (shouldStop(state, options, deadlineMs)) return;
      const result = await processFile(rawPath, matcher, {
        ...processorBaseOptions,
        currentMatchCount: state.matches.length,
      });
      updateState(state, result);
    } catch {
      state.skippedInaccessible++;
    }
  })();
}

export async function processStream(
  stream: AsyncIterable<string | Buffer>,
  searchState: SearchState,
  matcher: Matcher,
  options: SearchOptions,
  deadlineMs: number | undefined,
  searchPattern: string
): Promise<void> {
  const processing = createProcessingState(options, deadlineMs, searchPattern);

  for await (const entry of stream) {
    const action = await handleStreamEntry(
      entry,
      searchState,
      processing,
      matcher,
      options,
      deadlineMs
    );
    if (action === 'stop') break;
  }

  await Promise.all(processing.active);
}
