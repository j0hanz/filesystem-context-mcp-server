import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';

import type {
  ContentMatch,
  PendingMatch,
  ScanFileResult,
} from '../config/types.js';
import {
  MAX_LINE_CONTENT_LENGTH,
  REGEX_MATCH_TIMEOUT_MS,
} from './constants.js';

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

    if (match[0] === '') {
      const { lastIndex: newIndex } = regex;
      regex.lastIndex++;
      lastIndex = newIndex + 1;
      if (regex.lastIndex > line.length) break;
    } else {
      const { lastIndex: currentIndex } = regex;
      // Detect if regex is stuck (lastIndex not advancing)
      if (currentIndex === lastIndex) {
        return -1; // Regex not making progress
      }
      lastIndex = currentIndex;
    }

    const shouldCheckTimeout =
      (count > 0 && count % 10 === 0) ||
      (iterations > 0 && iterations % 50 === 0);
    if (shouldCheckTimeout && Date.now() > deadline) {
      return -1;
    }

    // Safety check for runaway regex
    if (iterations > maxIterations) {
      return -1; // Signal runaway regex
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

function prepareTrimmedLine(line: string): string {
  return line.trim().substring(0, MAX_LINE_CONTENT_LENGTH);
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
  } = options;
  const matches: ContentMatch[] = [];
  let linesSkippedDueToRegexTimeout = 0;
  let fileHadMatches = false;

  const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
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

      if (deadlineMs !== undefined && Date.now() > deadlineMs) break;
      if (currentMatchCount + matches.length >= maxResults) break;

      const trimmedLine = prepareTrimmedLine(line);
      updatePendingMatches(pendingMatches, trimmedLine);

      const matchCount =
        isLiteral && searchString
          ? countLiteralMatches(line, searchString, caseSensitive ?? false)
          : countRegexMatches(line, regex);

      if (matchCount < 0) {
        linesSkippedDueToRegexTimeout++;
        if (contextLines > 0) {
          contextBuffer.push(trimmedLine);
          if (contextBuffer.length > contextLines) contextBuffer.shift();
        }
        continue;
      }

      if (matchCount > 0) {
        fileHadMatches = true;
        const newMatch: ContentMatch = {
          file: filePath,
          line: lineNumber,
          content: trimmedLine,
          matchCount,
        };

        if (contextBuffer.length > 0) {
          newMatch.contextBefore = [...contextBuffer];
        }

        matches.push(newMatch);

        if (contextLines > 0) {
          pendingMatches.push({
            match: newMatch,
            afterNeeded: contextLines,
          });
        }
      }

      if (contextLines > 0) {
        contextBuffer.push(trimmedLine);
        if (contextBuffer.length > contextLines) contextBuffer.shift();
      }
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }

  return { matches, linesSkippedDueToRegexTimeout, fileHadMatches };
}
