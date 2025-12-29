import type { SearchContentResult } from '../../../config/types.js';
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCHABLE_FILE_SIZE,
} from '../../constants.js';
import { safeDestroy } from '../../fs-helpers.js';
import { mergeDefined } from '../../merge-defined.js';
import { validateExistingDirectory } from '../../path-validation.js';
import { validateGlobPatternOrThrow } from '../pattern-validator.js';
import { createStream, processStream } from './engine-stream.js';
import { createMatcher } from './match-strategy.js';
import type { SearchState } from './types.js';

export interface SearchOptions {
  filePattern: string;
  excludePatterns: string[];
  caseSensitive: boolean;
  maxResults: number;
  maxFileSize: number;
  maxFilesScanned: number;
  timeoutMs: number;
  skipBinary: boolean;
  contextLines: number;
  wholeWord: boolean;
  isLiteral: boolean;
  includeHidden: boolean;
  baseNameMatch: boolean;
  caseSensitiveFileMatch: boolean;
}

export interface SearchContentOptions extends Partial<SearchOptions> {
  signal?: AbortSignal;
}

function buildSearchOptions(
  partialOptions: Partial<SearchOptions>
): SearchOptions {
  const defaults: SearchOptions = {
    filePattern: '**/*',
    excludePatterns: [],
    caseSensitive: false,
    maxResults: DEFAULT_MAX_RESULTS,
    maxFileSize: MAX_SEARCHABLE_FILE_SIZE,
    maxFilesScanned: DEFAULT_SEARCH_MAX_FILES,
    timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
    skipBinary: true,
    contextLines: 0,
    wholeWord: false,
    isLiteral: false,
    includeHidden: false,
    baseNameMatch: false,
    caseSensitiveFileMatch: true,
  };

  return mergeDefined(defaults, partialOptions);
}

function getDeadlineMs(options: SearchOptions): number | undefined {
  return options.timeoutMs ? Date.now() + options.timeoutMs : undefined;
}

function createInitialState(): SearchState {
  return {
    matches: [],
    filesScanned: 0,
    filesMatched: 0,
    skippedTooLarge: 0,
    skippedBinary: 0,
    skippedInaccessible: 0,
    linesSkippedDueToRegexTimeout: 0,
    truncated: false,
    stoppedReason: undefined,
  };
}

function buildResult(
  basePath: string,
  pattern: string,
  state: SearchState,
  options: SearchOptions
): SearchContentResult {
  let { matches } = state;
  if (matches.length > options.maxResults) {
    matches = matches.slice(0, options.maxResults);
    state.truncated = true;
    state.stoppedReason = 'maxResults';
  }

  return {
    basePath,
    pattern,
    filePattern: options.filePattern,
    matches,
    summary: {
      filesScanned: state.filesScanned,
      filesMatched: state.filesMatched,
      matches: matches.length,
      truncated: state.truncated,
      skippedTooLarge: state.skippedTooLarge,
      skippedBinary: state.skippedBinary,
      skippedInaccessible: state.skippedInaccessible,
      linesSkippedDueToRegexTimeout: state.linesSkippedDueToRegexTimeout,
      stoppedReason: state.stoppedReason,
    },
  };
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Search aborted');
  }
}

function attachSignalAbort(
  signal: AbortSignal | undefined,
  controller: AbortController
): () => void {
  if (!signal) return () => {};

  const onAbort = (): void => {
    controller.abort();
  };

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return (): void => {
    signal.removeEventListener('abort', onAbort);
  };
}

function attachTimeoutAbort(
  deadlineMs: number | undefined,
  controller: AbortController
): () => void {
  if (!deadlineMs) return () => {};

  const delay = Math.max(0, deadlineMs - Date.now());
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, delay);

  return (): void => {
    clearTimeout(timeoutId);
  };
}

function createSearchSignal(
  signal: AbortSignal | undefined,
  deadlineMs: number | undefined
): { signal?: AbortSignal; cleanup: () => void } {
  if (!signal && !deadlineMs) {
    return { signal: undefined, cleanup: () => {} };
  }

  const controller = new AbortController();
  const detachSignal = attachSignalAbort(signal, controller);
  const clearTimeout = attachTimeoutAbort(deadlineMs, controller);

  return {
    signal: controller.signal,
    cleanup: (): void => {
      clearTimeout();
      detachSignal();
    },
  };
}

async function ensureSearchBasePath(
  basePath: string,
  options: SearchOptions,
  signal?: AbortSignal
): Promise<string> {
  assertNotAborted(signal);
  const validPath = await validateExistingDirectory(basePath, signal);
  validateGlobPatternOrThrow(options.filePattern, validPath);
  return validPath;
}

function buildMatcherForSearch(
  validPath: string,
  searchPattern: string,
  options: SearchOptions
): ReturnType<typeof createMatcher> {
  return createMatcher(searchPattern, {
    isLiteral: options.isLiteral,
    wholeWord: options.wholeWord,
    caseSensitive: options.caseSensitive,
    basePath: validPath,
  });
}

function createSearchStreamState(
  validPath: string,
  options: SearchOptions
): { state: SearchState; stream: AsyncIterable<string | Buffer> } {
  return {
    state: createInitialState(),
    stream: createStream(validPath, options),
  };
}

export async function executeSearch(
  basePath: string,
  searchPattern: string,
  partialOptions: Partial<SearchOptions>,
  signal?: AbortSignal
): Promise<SearchContentResult> {
  const options = buildSearchOptions(partialOptions);

  const deadlineMs = getDeadlineMs(options);
  const { signal: combinedSignal, cleanup } = createSearchSignal(
    signal,
    deadlineMs
  );
  const validPath = await ensureSearchBasePath(
    basePath,
    options,
    combinedSignal
  );
  const matcher = buildMatcherForSearch(validPath, searchPattern, options);
  const { state, stream } = createSearchStreamState(validPath, options);

  try {
    assertNotAborted(combinedSignal);
    await processStream(
      stream,
      state,
      matcher,
      options,
      deadlineMs,
      searchPattern,
      combinedSignal
    );
  } finally {
    cleanup();
    safeDestroy(stream);
  }

  return buildResult(validPath, searchPattern, state, options);
}

export async function searchContent(
  basePath: string,
  searchPattern: string,
  options: SearchContentOptions = {}
): Promise<SearchContentResult> {
  return executeSearch(basePath, searchPattern, options, options.signal);
}
