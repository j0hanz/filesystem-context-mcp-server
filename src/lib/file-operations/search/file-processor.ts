import * as fsPromises from 'node:fs/promises';
import type { ReadStream } from 'node:fs';

import type { ContentMatch } from '../../../config/types.js';
import {
  MAX_LINE_CONTENT_LENGTH,
  MAX_SEARCH_LINE_LENGTH,
} from '../../constants.js';
import { isProbablyBinary } from '../../fs-helpers.js';
import { withAbort } from '../../fs-helpers/abort.js';
import { validateExistingPathDetailed } from '../../path-validation.js';
import { ContextManager } from './context-manager.js';
import { iterateLines } from './line-iterator.js';
import type { Matcher } from './match-strategy.js';
import type { ScanResult, SearchOptions } from './types.js';

interface LineScanState {
  matches: ContentMatch[];
  linesSkipped: number;
  lineNumber: number;
  hitMaxResults: boolean;
}

function createEmptyResult(overrides: Partial<ScanResult>): ScanResult {
  return {
    matches: [],
    linesSkippedDueToRegexTimeout: 0,
    fileHadMatches: false,
    skippedTooLarge: false,
    skippedBinary: false,
    scanned: false,
    hitMaxResults: false,
    ...overrides,
  };
}

function createLineState(): LineScanState {
  return {
    matches: [],
    linesSkipped: 0,
    lineNumber: 0,
    hitMaxResults: false,
  };
}

function isDeadlineExceeded(deadlineMs: number | undefined): boolean {
  return deadlineMs !== undefined && Date.now() > deadlineMs;
}

function hasReachedMatchLimit(
  maxResults: number,
  matches: ContentMatch[],
  getCurrentMatchCount: () => number
): boolean {
  return getCurrentMatchCount() + matches.length >= maxResults;
}

function getLinePreview(line: string): string {
  return line.trimEnd().substring(0, MAX_LINE_CONTENT_LENGTH);
}

function updateContextLine(
  contextManager: ContextManager,
  line: string,
  needsContext: boolean
): string | undefined {
  if (!needsContext) return undefined;
  const trimmed = getLinePreview(line);
  contextManager.pushLine(trimmed);
  return trimmed;
}

function recordMatch(
  state: LineScanState,
  displayPath: string,
  line: string,
  trimmed: string | undefined,
  matchCount: number,
  contextManager: ContextManager
): void {
  const content = trimmed ?? getLinePreview(line);
  state.matches.push(
    contextManager.createMatch(
      displayPath,
      state.lineNumber,
      content,
      matchCount
    )
  );
}

function handleMatchCount(
  matchCount: number,
  state: LineScanState,
  displayPath: string,
  line: string,
  trimmed: string | undefined,
  contextManager: ContextManager
): void {
  if (matchCount < 0) {
    state.linesSkipped++;
    return;
  }
  if (matchCount === 0) return;
  recordMatch(state, displayPath, line, trimmed, matchCount, contextManager);
}

function processLine(
  line: string,
  state: LineScanState,
  displayPath: string,
  matcher: Matcher,
  options: SearchOptions,
  contextManager: ContextManager,
  getCurrentMatchCount: () => number,
  needsContext: boolean
): boolean {
  if (options.signal?.aborted) return false;
  state.lineNumber++;

  if (isDeadlineExceeded(options.deadlineMs)) return false;
  if (options.hasRemainingMatchBudget && !options.hasRemainingMatchBudget()) {
    state.hitMaxResults = true;
    return false;
  }
  if (
    hasReachedMatchLimit(
      options.maxResults,
      state.matches,
      getCurrentMatchCount
    )
  ) {
    state.hitMaxResults = true;
    return false;
  }

  const trimmed = updateContextLine(contextManager, line, needsContext);
  const matchCount = matcher(line);
  if (matchCount > 0 && options.reserveMatchSlot) {
    if (!options.reserveMatchSlot()) {
      state.hitMaxResults = true;
      return false;
    }
  }
  handleMatchCount(
    matchCount,
    state,
    displayPath,
    line,
    trimmed,
    contextManager
  );

  return true;
}

async function scanLines(
  stream: ReadStream,
  displayPath: string,
  matcher: Matcher,
  options: SearchOptions,
  contextManager: ContextManager
): Promise<{
  matches: ContentMatch[];
  linesSkipped: number;
  hitMaxResults: boolean;
}> {
  const state = createLineState();
  const needsContext = options.contextLines > 0;
  const getCurrentMatchCount =
    options.getCurrentMatchCount ?? (() => options.currentMatchCount);

  for await (const line of iterateLines(
    stream,
    MAX_SEARCH_LINE_LENGTH,
    options.signal
  )) {
    const shouldContinue = processLine(
      line,
      state,
      displayPath,
      matcher,
      options,
      contextManager,
      getCurrentMatchCount,
      needsContext
    );
    if (!shouldContinue) break;
  }

  return {
    matches: state.matches,
    linesSkipped: state.linesSkipped,
    hitMaxResults: state.hitMaxResults,
  };
}

async function scanContent(
  handle: fsPromises.FileHandle,
  displayPath: string,
  matcher: Matcher,
  options: SearchOptions
): Promise<ScanResult> {
  const contextManager = new ContextManager(options.contextLines);
  const stream = handle.createReadStream({
    encoding: 'utf-8',
    autoClose: false,
  });

  try {
    const { matches, linesSkipped, hitMaxResults } = await scanLines(
      stream,
      displayPath,
      matcher,
      options,
      contextManager
    );
    return {
      matches,
      linesSkippedDueToRegexTimeout: linesSkipped,
      fileHadMatches: matches.length > 0,
      skippedTooLarge: false,
      skippedBinary: false,
      scanned: true,
      hitMaxResults,
    };
  } finally {
    stream.destroy();
  }
}

async function scanWithHandle(
  handle: fsPromises.FileHandle,
  openPath: string,
  displayPath: string,
  matcher: Matcher,
  options: SearchOptions
): Promise<ScanResult> {
  const stats = await withAbort(handle.stat(), options.signal);
  if (stats.size > options.maxFileSize) {
    return createEmptyResult({ scanned: true, skippedTooLarge: true });
  }

  if (
    options.skipBinary &&
    (await isProbablyBinary(openPath, handle, options.signal))
  ) {
    return createEmptyResult({ scanned: true, skippedBinary: true });
  }

  return await scanContent(handle, displayPath, matcher, options);
}

export async function processFile(
  rawPath: string,
  matcher: Matcher,
  options: SearchOptions
): Promise<ScanResult> {
  if (options.signal?.aborted) {
    return createEmptyResult({ scanned: true });
  }

  let openPath: string;
  let displayPath: string;
  try {
    const validated = await validateExistingPathDetailed(
      rawPath,
      options.signal
    );
    openPath = validated.resolvedPath;
    displayPath = validated.requestedPath;
  } catch {
    return createEmptyResult({ scanned: false });
  }

  const handle = await withAbort(
    fsPromises.open(openPath, 'r'),
    options.signal
  );
  try {
    return await scanWithHandle(
      handle,
      openPath,
      displayPath,
      matcher,
      options
    );
  } finally {
    await handle.close();
  }
}
