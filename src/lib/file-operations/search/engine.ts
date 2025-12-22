import type { SearchContentResult } from '../../../config/types.js';
import { safeDestroy } from '../../fs-helpers.js';
import { validateExistingPath } from '../../path-validation.js';
import { validateGlobPatternOrThrow } from '../pattern-validator.js';
import { buildSearchOptions, getDeadlineMs } from './engine-options.js';
import type { SearchOptions } from './engine-options.js';
import { createStream, processStream } from './engine-stream.js';
import { createMatcher } from './match-strategy.js';
import type { SearchState } from './types.js';

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

export async function executeSearch(
  basePath: string,
  searchPattern: string,
  partialOptions: Partial<SearchOptions>
): Promise<SearchContentResult> {
  const options = buildSearchOptions(partialOptions);

  const validPath = await validateExistingPath(basePath);
  validateGlobPatternOrThrow(options.filePattern, validPath);

  const matcher = createMatcher(searchPattern, {
    isLiteral: options.isLiteral,
    wholeWord: options.wholeWord,
    caseSensitive: options.caseSensitive,
    basePath: validPath,
  });

  const state = createInitialState();
  const deadlineMs = getDeadlineMs(options);
  const stream = createStream(validPath, options);

  try {
    await processStream(
      stream,
      state,
      matcher,
      options,
      deadlineMs,
      searchPattern
    );
  } finally {
    safeDestroy(stream);
  }

  return buildResult(validPath, searchPattern, state, options);
}
