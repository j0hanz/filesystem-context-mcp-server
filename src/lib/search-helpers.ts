import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import type { ContentMatch } from '../config/types.js';
import {
  MAX_LINE_CONTENT_LENGTH,
  REGEX_MATCH_TIMEOUT_MS,
} from './constants.js';

interface PendingMatch {
  match: ContentMatch;
  afterNeeded: number;
}

interface ScanFileResult {
  matches: ContentMatch[];
  linesSkippedDueToRegexTimeout: number;
  fileHadMatches: boolean;
}

interface MatchCountOptions {
  isLiteral?: boolean;
  searchString?: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
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

    const {
      status,
      lastIndex: nextIndex,
      shouldBreak,
    } = advanceRegexMatch(regex, match, line.length, lastIndex);
    if (status === 'stuck') {
      return -1;
    }
    lastIndex = nextIndex;
    if (shouldBreak) {
      break;
    }

    if (shouldAbortRegex(count, iterations, deadline, maxIterations)) {
      return -1;
    }
  }

  return count;
}

export function isSimpleSafePattern(pattern: string): boolean {
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

function updatePendingMatches(
  pendingMatches: PendingMatch[],
  trimmedLine: string
): void {
  for (const pending of pendingMatches) {
    if (pending.afterNeeded > 0) {
      pending.match.contextAfter ??= [];
      pending.match.contextAfter.push(trimmedLine);
      pending.afterNeeded--;
    }
  }
  while (pendingMatches.length > 0 && pendingMatches[0]?.afterNeeded === 0) {
    pendingMatches.shift();
  }
}

export function prepareSearchPattern(
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

export async function scanFileForContent(
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
    fileHandle?: FileHandle;
  }
): Promise<ScanFileResult> {
  const {
    maxResults,
    contextLines,
    deadlineMs,
    currentMatchCount,
    isLiteral,
    searchString,
    caseSensitive,
    wholeWord,
    fileHandle,
  } = options;
  const matches: ContentMatch[] = [];
  let linesSkippedDueToRegexTimeout = 0;
  let fileHadMatches = false;

  const fileStream =
    fileHandle?.createReadStream({ encoding: 'utf-8', autoClose: false }) ??
    createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  const contextBuffer: string[] = [];
  const pendingMatches: PendingMatch[] = [];

  try {
    for await (const line of rl) {
      lineNumber++;

      if (shouldStopScan(deadlineMs, currentMatchCount, matches, maxResults)) {
        break;
      }

      const trimmedLine = trimAndClampLine(line);
      updatePendingMatches(pendingMatches, trimmedLine);

      const matchCount = getMatchCount(line, regex, {
        isLiteral,
        searchString,
        caseSensitive,
        wholeWord,
      });

      if (matchCount < 0) {
        linesSkippedDueToRegexTimeout++;
        pushContextLine(contextBuffer, trimmedLine, contextLines);
        continue;
      }

      if (matchCount > 0) {
        fileHadMatches = true;
        const newMatch = buildMatch(
          filePath,
          lineNumber,
          trimmedLine,
          matchCount,
          contextBuffer
        );
        matches.push(newMatch);
        queueContextAfter(pendingMatches, newMatch, contextLines);
      }

      pushContextLine(contextBuffer, trimmedLine, contextLines);
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }

  return { matches, linesSkippedDueToRegexTimeout, fileHadMatches };
}

function shouldStopScan(
  deadlineMs: number | undefined,
  currentMatchCount: number,
  matches: ContentMatch[],
  maxResults: number
): boolean {
  if (deadlineMs !== undefined && Date.now() > deadlineMs) return true;
  return currentMatchCount + matches.length >= maxResults;
}

function trimAndClampLine(line: string): string {
  return line.trim().substring(0, MAX_LINE_CONTENT_LENGTH);
}

function getMatchCount(
  line: string,
  regex: RegExp,
  options: MatchCountOptions
): number {
  if (options.isLiteral && options.searchString && !options.wholeWord) {
    return countLiteralMatches(
      line,
      options.searchString,
      options.caseSensitive ?? false
    );
  }
  return countRegexMatches(line, regex);
}

function buildMatch(
  file: string,
  line: number,
  content: string,
  matchCount: number,
  contextBuffer: string[]
): ContentMatch {
  const match: ContentMatch = {
    file,
    line,
    content,
    matchCount,
  };
  if (contextBuffer.length > 0) {
    match.contextBefore = [...contextBuffer];
  }
  return match;
}

function queueContextAfter(
  pendingMatches: PendingMatch[],
  match: ContentMatch,
  contextLines: number
): void {
  if (contextLines <= 0) return;
  pendingMatches.push({
    match,
    afterNeeded: contextLines,
  });
}

function pushContextLine(
  contextBuffer: string[],
  trimmedLine: string,
  contextLines: number
): void {
  if (contextLines <= 0) return;
  contextBuffer.push(trimmedLine);
  if (contextBuffer.length > contextLines) contextBuffer.shift();
}

function shouldAbortRegex(
  count: number,
  iterations: number,
  deadline: number,
  maxIterations: number
): boolean {
  const shouldCheckTimeout =
    (count > 0 && count % 10 === 0) ||
    (iterations > 0 && iterations % 50 === 0);
  if (shouldCheckTimeout && Date.now() > deadline) {
    return true;
  }
  return iterations > maxIterations;
}

function advanceRegexMatch(
  regex: RegExp,
  match: RegExpExecArray,
  lineLength: number,
  lastIndex: number
): { status: 'ok' | 'stuck'; lastIndex: number; shouldBreak: boolean } {
  if (match[0] === '') {
    const { lastIndex: newIndex } = regex;
    regex.lastIndex++;
    const nextIndex = newIndex + 1;
    const shouldBreak = regex.lastIndex > lineLength;
    return { status: 'ok', lastIndex: nextIndex, shouldBreak };
  }

  const { lastIndex: currentIndex } = regex;
  if (currentIndex === lastIndex) {
    return { status: 'stuck', lastIndex, shouldBreak: true };
  }
  return { status: 'ok', lastIndex: currentIndex, shouldBreak: false };
}
