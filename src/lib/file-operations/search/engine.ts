import fg from 'fast-glob';

import type { SearchContentResult } from '../../../config/types.js';
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCHABLE_FILE_SIZE,
  PARALLEL_CONCURRENCY,
} from '../../constants.js';
import { safeDestroy } from '../../fs-helpers.js';
import { validateExistingPath } from '../../path-validation.js';
import { validateGlobPatternOrThrow } from '../pattern-validator.js';
import { processFile } from './file-processor.js';
import { createMatcher } from './match-strategy.js';
import type { ScanResult, SearchState } from './types.js';

interface SearchOptions {
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

function createStream(
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

export async function executeSearch(
  basePath: string,
  searchPattern: string,
  partialOptions: Partial<SearchOptions>
): Promise<SearchContentResult> {
  const options: SearchOptions = {
    filePattern: partialOptions.filePattern ?? '**/*',
    excludePatterns: partialOptions.excludePatterns ?? [],
    caseSensitive: partialOptions.caseSensitive ?? false,
    maxResults: partialOptions.maxResults ?? DEFAULT_MAX_RESULTS,
    maxFileSize: partialOptions.maxFileSize ?? MAX_SEARCHABLE_FILE_SIZE,
    maxFilesScanned: partialOptions.maxFilesScanned ?? DEFAULT_SEARCH_MAX_FILES,
    timeoutMs: partialOptions.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    skipBinary: partialOptions.skipBinary ?? true,
    contextLines: partialOptions.contextLines ?? 0,
    wholeWord: partialOptions.wholeWord ?? false,
    isLiteral: partialOptions.isLiteral ?? false,
    includeHidden: partialOptions.includeHidden ?? false,
    baseNameMatch: partialOptions.baseNameMatch ?? false,
    caseSensitiveFileMatch: partialOptions.caseSensitiveFileMatch ?? true,
  };

  const validPath = await validateExistingPath(basePath);
  validateGlobPatternOrThrow(options.filePattern, validPath);

  const matcher = createMatcher(searchPattern, {
    isLiteral: options.isLiteral,
    wholeWord: options.wholeWord,
    caseSensitive: options.caseSensitive,
    basePath: validPath,
  });

  const state = createInitialState();
  const deadlineMs = options.timeoutMs
    ? Date.now() + options.timeoutMs
    : undefined;

  const processorBaseOptions = {
    ...options,
    deadlineMs,
    searchPattern,
  };

  const stream = createStream(validPath, options);
  const active = new Set<Promise<void>>();
  let inFlight = 0;

  try {
    for await (const entry of stream) {
      if (shouldStop(state, options, deadlineMs)) break;

      if (state.filesScanned + inFlight >= options.maxFilesScanned) {
        if (active.size > 0) {
          await Promise.race(active);
          continue;
        } else {
          break;
        }
      }

      while (active.size >= PARALLEL_CONCURRENCY) {
        await Promise.race(active);
      }

      const rawPath = String(entry);
      inFlight++;
      const p = (async (): Promise<void> => {
        try {
          if (shouldStop(state, options, deadlineMs)) return;
          const processorOptions = {
            ...processorBaseOptions,
            currentMatchCount: state.matches.length,
          };
          const result = await processFile(rawPath, matcher, processorOptions);
          updateState(state, result);
        } catch {
          state.skippedInaccessible++;
        } finally {
          inFlight--;
        }
      })();

      active.add(p);
      void p.finally(() => active.delete(p));
    }
    await Promise.all(active);
  } finally {
    safeDestroy(stream);
  }

  return buildResult(validPath, searchPattern, state, options);
}
