import * as fs from 'node:fs/promises';
import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';

import fg from 'fast-glob';
import safeRegex from 'safe-regex2';

import type { ContentMatch, SearchContentResult } from '../../config/types.js';
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_LINE_CONTENT_LENGTH,
  MAX_SEARCHABLE_FILE_SIZE,
  REGEX_MATCH_TIMEOUT_MS,
} from '../constants.js';
import { ErrorCode, McpError } from '../errors.js';
import { isProbablyBinary, safeDestroy } from '../fs-helpers.js';
import {
  validateExistingPath,
  validateExistingPathDetailed,
} from '../path-validation.js';
import { validateGlobPatternOrThrow } from './pattern-validator.js';

interface SearchContentState {
  matches: ContentMatch[];
  filesScanned: number;
  filesMatched: number;
  skippedTooLarge: number;
  skippedBinary: number;
  skippedInaccessible: number;
  linesSkippedDueToRegexTimeout: number;
  truncated: boolean;
  stoppedReason: SearchContentResult['summary']['stoppedReason'];
}

interface CandidateScanResult {
  matches: ContentMatch[];
  fileHadMatches: boolean;
  linesSkippedDueToRegexTimeout: number;
  skippedTooLarge: boolean;
  skippedBinary: boolean;
  scanned: boolean;
}

function initSearchContentState(): SearchContentState {
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

type SearchStopReason = SearchContentResult['summary']['stoppedReason'];

function getSearchStopReason(
  deadlineMs: number | undefined,
  maxFilesScanned: number | undefined,
  maxResults: number,
  filesScanned: number,
  matchCount: number
): SearchStopReason | undefined {
  if (deadlineMs !== undefined && Date.now() > deadlineMs) return 'timeout';
  if (maxFilesScanned !== undefined && filesScanned >= maxFilesScanned) {
    return 'maxFiles';
  }
  if (matchCount >= maxResults) return 'maxResults';
  return undefined;
}

function applySearchStop(
  state: SearchContentState,
  reason: SearchStopReason
): void {
  state.truncated = true;
  state.stoppedReason = reason;
}

function getStopReasonIfAny(
  state: SearchContentState,
  options: {
    deadlineMs?: number;
    maxFilesScanned?: number;
    maxResults: number;
  }
): SearchStopReason | undefined {
  return getSearchStopReason(
    options.deadlineMs,
    options.maxFilesScanned,
    options.maxResults,
    state.filesScanned,
    state.matches.length
  );
}

function applyStopIfNeeded(
  state: SearchContentState,
  reason: SearchStopReason | undefined
): boolean {
  if (!reason) return false;
  applySearchStop(state, reason);
  return true;
}

function isSimpleSafePattern(pattern: string): boolean {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return false;
  }

  const nestedQuantifierPattern = /[+*?}]\s*\)\s*[+*?{]/;
  if (nestedQuantifierPattern.test(pattern)) {
    return false;
  }

  const highRepetitionPattern = /\{(\d+)(?:,\d*)?\}/g;
  let match;
  while ((match = highRepetitionPattern.exec(pattern)) !== null) {
    const countStr = match[1];
    if (countStr === undefined) continue;

    const count = parseInt(countStr, 10);
    if (Number.isNaN(count) || count >= 25) {
      return false;
    }
  }

  return true;
}

function prepareSearchPattern(
  searchPattern: string,
  options: { isLiteral?: boolean; wholeWord?: boolean }
): string {
  let finalPattern = searchPattern;

  if (options.isLiteral) {
    finalPattern = finalPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  if (options.wholeWord) {
    finalPattern = `\\b${finalPattern}\\b`;
  }

  return finalPattern;
}

function ensureSafePattern(
  finalPattern: string,
  searchPattern: string,
  basePath: string,
  needsReDoSCheck: boolean
): void {
  if (!needsReDoSCheck || safeRegex(finalPattern)) return;

  throw new McpError(
    ErrorCode.E_INVALID_PATTERN,
    `Potentially unsafe regular expression (ReDoS risk): ${searchPattern}. ` +
      'Avoid patterns with nested quantifiers, overlapping alternations, or exponential backtracking.',
    basePath,
    { reason: 'ReDoS risk detected' }
  );
}

function compileRegex(
  finalPattern: string,
  caseSensitive: boolean,
  basePath: string
): RegExp {
  try {
    return new RegExp(finalPattern, caseSensitive ? 'g' : 'gi');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpError(
      ErrorCode.E_INVALID_PATTERN,
      `Invalid regular expression: ${finalPattern} (${message})`,
      basePath,
      { searchPattern: finalPattern }
    );
  }
}

function buildSearchRegex(
  searchPattern: string,
  options: {
    isLiteral: boolean;
    wholeWord: boolean;
    caseSensitive: boolean;
    basePath: string;
  }
): { regex: RegExp; finalPattern: string } {
  const { isLiteral, wholeWord, caseSensitive, basePath } = options;
  const finalPattern = prepareSearchPattern(searchPattern, {
    isLiteral,
    wholeWord,
  });
  const needsReDoSCheck = !isLiteral && !isSimpleSafePattern(finalPattern);
  ensureSafePattern(finalPattern, searchPattern, basePath, needsReDoSCheck);

  return {
    regex: compileRegex(finalPattern, caseSensitive, basePath),
    finalPattern,
  };
}

function countLiteralMatches(
  line: string,
  searchString: string,
  caseSensitive: boolean
): number {
  if (line.length === 0 || searchString.length === 0) return 0;

  const haystack = caseSensitive ? line : line.toLowerCase();
  const needle = caseSensitive ? searchString : searchString.toLowerCase();

  let count = 0;
  let pos = 0;

  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }

  return count;
}

function countRegexMatches(
  line: string,
  regex: RegExp,
  timeoutMs: number = REGEX_MATCH_TIMEOUT_MS
): number {
  if (line.length === 0) return 0;

  regex.lastIndex = 0;
  let count = 0;
  const deadline = Date.now() + timeoutMs;
  const maxIterations = Math.min(line.length * 2, 10000);
  let iterations = 0;
  let lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    count++;
    iterations++;

    const { lastIndex: currentIndex } = regex;
    if (match[0] === '') {
      regex.lastIndex++;
    }
    if (currentIndex === lastIndex) {
      return -1;
    }
    ({ lastIndex } = regex);

    const shouldCheckTimeout =
      (count > 0 && count % 10 === 0) ||
      (iterations > 0 && iterations % 50 === 0);
    if (
      (shouldCheckTimeout && Date.now() > deadline) ||
      iterations > maxIterations
    ) {
      return -1;
    }
  }

  return count;
}

function scanFileForContent(
  filePath: string,
  regex: RegExp,
  options: {
    maxResults: number;
    contextLines: number;
    deadlineMs?: number;
    currentMatchCount: number;
    isLiteral?: boolean;
    searchString?: string;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    fileHandle?: fs.FileHandle;
  }
): Promise<{
  matches: ContentMatch[];
  linesSkippedDueToRegexTimeout: number;
  fileHadMatches: boolean;
}> {
  const state = {
    matches: [] as ContentMatch[],
    linesSkippedDueToRegexTimeout: 0,
    fileHadMatches: false,
    lineNumber: 0,
    contextBuffer: [] as string[],
    pendingMatches: [] as {
      match: ContentMatch;
      afterNeeded: number;
    }[],
  };

  const trimAndClampLine = (line: string): string =>
    line.trimEnd().substring(0, MAX_LINE_CONTENT_LENGTH);

  const getMatchCount = (line: string): number => {
    if (options.isLiteral && options.searchString && !options.wholeWord) {
      return countLiteralMatches(
        line,
        options.searchString,
        options.caseSensitive ?? false
      );
    }
    return countRegexMatches(line, regex);
  };

  const updatePending = (trimmedLine: string): void => {
    for (const pending of state.pendingMatches) {
      if (pending.afterNeeded > 0) {
        pending.match.contextAfter ??= [];
        pending.match.contextAfter.push(trimmedLine);
        pending.afterNeeded--;
      }
    }
    while (state.pendingMatches[0]?.afterNeeded === 0) {
      state.pendingMatches.shift();
    }
  };

  const pushContextLine = (trimmedLine: string): void => {
    if (options.contextLines <= 0) return;
    state.contextBuffer.push(trimmedLine);
    if (state.contextBuffer.length > options.contextLines) {
      state.contextBuffer.shift();
    }
  };

  const buildMatch = (
    line: number,
    content: string,
    matchCount: number
  ): ContentMatch => {
    const match: ContentMatch = {
      file: filePath,
      line,
      content,
      matchCount,
    };
    if (state.contextBuffer.length > 0) {
      match.contextBefore = [...state.contextBuffer];
    }
    return match;
  };

  const queueAfter = (match: ContentMatch): void => {
    if (options.contextLines <= 0) return;
    state.pendingMatches.push({ match, afterNeeded: options.contextLines });
  };

  const handleLine = (line: string): boolean => {
    state.lineNumber++;
    if (options.deadlineMs !== undefined && Date.now() > options.deadlineMs) {
      return true;
    }
    if (
      state.matches.length + options.currentMatchCount >=
      options.maxResults
    ) {
      return true;
    }

    const trimmed = trimAndClampLine(line);
    updatePending(trimmed);

    const matchCount = getMatchCount(line);
    if (matchCount < 0) {
      state.linesSkippedDueToRegexTimeout++;
      pushContextLine(trimmed);
      return false;
    }

    if (matchCount > 0) {
      state.fileHadMatches = true;
      const m = buildMatch(state.lineNumber, trimmed, matchCount);
      state.matches.push(m);
      queueAfter(m);
    }

    pushContextLine(trimmed);
    return false;
  };

  const { rl, stream } = (() => {
    const fileStream =
      options.fileHandle?.createReadStream({
        encoding: 'utf-8',
        autoClose: false,
      }) ?? createReadStream(filePath, { encoding: 'utf-8' });
    const reader = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });
    return { rl: reader, stream: fileStream };
  })();

  return (async () => {
    try {
      for await (const line of rl) {
        if (handleLine(line)) break;
      }
    } finally {
      rl.close();
      stream.destroy();
    }

    return {
      matches: state.matches,
      linesSkippedDueToRegexTimeout: state.linesSkippedDueToRegexTimeout,
      fileHadMatches: state.fileHadMatches,
    };
  })();
}

async function resolveSearchPath(
  rawPath: string
): Promise<{ openPath: string; displayPath: string } | null> {
  try {
    const validatedPath = await validateExistingPathDetailed(rawPath);
    return {
      openPath: validatedPath.resolvedPath,
      displayPath: validatedPath.requestedPath,
    };
  } catch {
    return null;
  }
}

function mapMatchesToDisplayPath(
  matches: ContentMatch[],
  displayPath: string
): ContentMatch[] {
  return matches.map((match) => ({ ...match, file: displayPath }));
}

function buildSkipResult(
  scanned: boolean,
  skippedTooLarge: boolean,
  skippedBinary: boolean
): CandidateScanResult {
  return {
    matches: [],
    fileHadMatches: false,
    linesSkippedDueToRegexTimeout: 0,
    skippedTooLarge,
    skippedBinary,
    scanned,
  };
}

async function scanWithHandle(
  handle: fs.FileHandle,
  openPath: string,
  displayPath: string,
  regex: RegExp,
  options: {
    maxResults: number;
    currentMatchCount: number;
    maxFileSize: number;
    skipBinary: boolean;
    isLiteral: boolean;
    searchPattern: string;
    caseSensitive: boolean;
    contextLines: number;
    wholeWord: boolean;
    deadlineMs?: number;
  }
): Promise<CandidateScanResult> {
  const stats = await handle.stat();
  if (stats.size > options.maxFileSize) {
    return buildSkipResult(true, true, false);
  }

  if (options.skipBinary) {
    const binary = await isProbablyBinary(openPath, handle);
    if (binary) {
      return buildSkipResult(true, false, true);
    }
  }

  const scanResult: Awaited<ReturnType<typeof scanFileForContent>> =
    await scanFileForContent(openPath, regex, {
      maxResults: options.maxResults,
      contextLines: options.contextLines,
      deadlineMs: options.deadlineMs,
      currentMatchCount: options.currentMatchCount,
      isLiteral: options.isLiteral,
      searchString: options.isLiteral ? options.searchPattern : undefined,
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
      fileHandle: handle,
    });

  const mappedMatches = mapMatchesToDisplayPath(
    scanResult.matches,
    displayPath
  );

  return {
    matches: mappedMatches,
    fileHadMatches: scanResult.fileHadMatches,
    linesSkippedDueToRegexTimeout: scanResult.linesSkippedDueToRegexTimeout,
    skippedTooLarge: false,
    skippedBinary: false,
    scanned: true,
  };
}

async function scanCandidateFile(
  openPath: string,
  displayPath: string,
  regex: RegExp,
  options: {
    maxResults: number;
    currentMatchCount: number;
    maxFileSize: number;
    skipBinary: boolean;
    isLiteral: boolean;
    searchPattern: string;
    caseSensitive: boolean;
    contextLines: number;
    wholeWord: boolean;
    deadlineMs?: number;
  }
): Promise<CandidateScanResult> {
  const handle = await fs.open(openPath, 'r');

  try {
    return await scanWithHandle(handle, openPath, displayPath, regex, options);
  } finally {
    await handle.close().catch(() => {});
  }
}

function updateStateFromScan(
  state: SearchContentState,
  scanResult: CandidateScanResult
): void {
  if (scanResult.scanned) state.filesScanned++;
  if (scanResult.skippedTooLarge) {
    state.skippedTooLarge++;
    return;
  }
  if (scanResult.skippedBinary) {
    state.skippedBinary++;
    return;
  }

  state.matches.push(...scanResult.matches);
  state.linesSkippedDueToRegexTimeout +=
    scanResult.linesSkippedDueToRegexTimeout;
  if (scanResult.fileHadMatches) state.filesMatched++;
}

function createSearchStream(
  basePath: string,
  filePattern: string,
  excludePatterns: string[],
  includeHidden: boolean,
  baseNameMatch = false,
  caseSensitiveFileMatch = true
): AsyncIterable<string | Buffer> {
  return fg.stream(filePattern, {
    cwd: basePath,
    absolute: true,
    onlyFiles: true,
    dot: includeHidden,
    ignore: excludePatterns,
    suppressErrors: true,
    followSymbolicLinks: false,
    baseNameMatch,
    caseSensitiveMatch: caseSensitiveFileMatch,
  });
}

async function scanSearchStream(
  stream: AsyncIterable<string | Buffer>,
  state: SearchContentState,
  options: {
    deadlineMs?: number;
    maxFilesScanned?: number;
    maxResults: number;
    maxFileSize: number;
    skipBinary: boolean;
    isLiteral: boolean;
    searchPattern: string;
    caseSensitive: boolean;
    contextLines: number;
    wholeWord: boolean;
  },
  regex: RegExp
): Promise<void> {
  for await (const entry of stream) {
    const rawPath = typeof entry === 'string' ? entry : String(entry);
    const resolved = await resolveSearchPath(rawPath);
    if (!resolved) {
      state.skippedInaccessible++;
      continue;
    }

    if (applyStopIfNeeded(state, getStopReasonIfAny(state, options))) break;

    try {
      const scanResult = await scanCandidateFile(
        resolved.openPath,
        resolved.displayPath,
        regex,
        {
          maxResults: options.maxResults,
          currentMatchCount: state.matches.length,
          maxFileSize: options.maxFileSize,
          skipBinary: options.skipBinary,
          isLiteral: options.isLiteral,
          searchPattern: options.searchPattern,
          caseSensitive: options.caseSensitive,
          contextLines: options.contextLines,
          wholeWord: options.wholeWord,
          deadlineMs: options.deadlineMs,
        }
      );

      updateStateFromScan(state, scanResult);
    } catch {
      state.skippedInaccessible++;
    }

    if (applyStopIfNeeded(state, getStopReasonIfAny(state, options))) break;
  }
}

export async function searchContent(
  basePath: string,
  searchPattern: string,
  options: {
    filePattern?: string;
    excludePatterns?: string[];
    caseSensitive?: boolean;
    maxResults?: number;
    maxFileSize?: number;
    maxFilesScanned?: number;
    timeoutMs?: number;
    skipBinary?: boolean;
    contextLines?: number;
    wholeWord?: boolean;
    isLiteral?: boolean;
    includeHidden?: boolean;
    baseNameMatch?: boolean;
    caseSensitiveFileMatch?: boolean;
  } = {}
): Promise<SearchContentResult> {
  const {
    filePattern = '**/*',
    excludePatterns = [],
    caseSensitive = false,
    maxResults = DEFAULT_MAX_RESULTS,
    maxFileSize = MAX_SEARCHABLE_FILE_SIZE,
    maxFilesScanned = DEFAULT_SEARCH_MAX_FILES,
    timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS,
    skipBinary = true,
    contextLines = 0,
    wholeWord = false,
    isLiteral = false,
    includeHidden = false,
    baseNameMatch,
    caseSensitiveFileMatch,
  } = options;

  const validPath = await validateExistingPath(basePath);

  // Validate file pattern
  validateGlobPatternOrThrow(filePattern, validPath);

  const deadlineMs = timeoutMs ? Date.now() + timeoutMs : undefined;
  const { regex } = buildSearchRegex(searchPattern, {
    isLiteral,
    wholeWord,
    caseSensitive,
    basePath,
  });

  const state = initSearchContentState();
  const stream = createSearchStream(
    validPath,
    filePattern,
    excludePatterns,
    includeHidden,
    baseNameMatch ?? false,
    caseSensitiveFileMatch ?? true
  );

  try {
    await scanSearchStream(
      stream,
      state,
      {
        deadlineMs,
        maxFilesScanned,
        maxResults,
        maxFileSize,
        skipBinary,
        isLiteral,
        searchPattern,
        caseSensitive,
        contextLines,
        wholeWord,
      },
      regex
    );
  } finally {
    safeDestroy(stream);
  }

  return {
    basePath: validPath,
    pattern: searchPattern,
    filePattern,
    matches: state.matches,
    summary: {
      filesScanned: state.filesScanned,
      filesMatched: state.filesMatched,
      matches: state.matches.length,
      truncated: state.truncated,
      skippedTooLarge: state.skippedTooLarge,
      skippedBinary: state.skippedBinary,
      skippedInaccessible: state.skippedInaccessible,
      linesSkippedDueToRegexTimeout: state.linesSkippedDueToRegexTimeout,
      stoppedReason: state.stoppedReason,
    },
  };
}
