import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';

import type { ContentMatch, ScanFileResult } from '../config/types.js';
import {
  MAX_LINE_CONTENT_LENGTH,
  REGEX_MATCH_TIMEOUT_MS,
} from './constants.js';

// Pending match tracker for context-after lines
interface PendingMatch {
  match: ContentMatch;
  afterNeeded: number;
}

// Count literal string matches in a line
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

// Count regex matches with timeout protection (returns -1 on timeout)
function countRegexMatches(
  line: string,
  regex: RegExp,
  timeoutMs: number = REGEX_MATCH_TIMEOUT_MS
): number {
  // Safety check for empty line
  if (line.length === 0) return 0;

  regex.lastIndex = 0;
  let count = 0;
  const deadline = Date.now() + timeoutMs;
  // Hard cap prevents issues with extremely long lines (e.g., minified JS)
  const maxIterations = Math.min(line.length * 2, 10000);
  let iterations = 0;
  let lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    count++;
    iterations++;

    // Prevent infinite loops on zero-width matches
    if (match[0] === '') {
      const { lastIndex: newIndex } = regex;
      regex.lastIndex++;
      lastIndex = newIndex + 1;
      // Prevent advancing beyond string length
      if (regex.lastIndex > line.length) break;
    } else {
      const { lastIndex: currentIndex } = regex;
      // Detect if regex is stuck (lastIndex not advancing)
      if (currentIndex === lastIndex) {
        return -1; // Regex not making progress
      }
      lastIndex = currentIndex;
    }

    // Hybrid timeout check for both fast and slow regex patterns
    const shouldCheckTimeout =
      (count > 0 && count % 10 === 0) ||
      (iterations > 0 && iterations % 50 === 0);
    if (shouldCheckTimeout && Date.now() > deadline) {
      return -1; // Signal timeout
    }

    // Safety check for runaway regex
    if (iterations > maxIterations) {
      return -1; // Signal runaway regex
    }
  }

  return count;
}

// Check if regex is simple enough to be safe without full ReDoS check
export function isSimpleSafePattern(pattern: string): boolean {
  // Validate input
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return false;
  }

  // Patterns with nested quantifiers are the main ReDoS concern
  const nestedQuantifierPattern = /[+*?}]\s*\)\s*[+*?{]/;
  if (nestedQuantifierPattern.test(pattern)) {
    return false;
  }

  // Check for high repetition counts that safe-regex2 would flag (default limit is 25)
  const highRepetitionPattern = /\{(\d+)(?:,\d*)?\}/g;
  let match;
  while ((match = highRepetitionPattern.exec(pattern)) !== null) {
    const countStr = match[1];
    if (countStr === undefined) continue;

    const count = parseInt(countStr, 10);
    // Check for NaN and high values
    if (Number.isNaN(count) || count >= 25) {
      return false;
    }
  }

  return true;
}

// Process pending matches to add context-after lines
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
  // Remove completed pending matches from the front
  while (pendingMatches.length > 0 && pendingMatches[0]?.afterNeeded === 0) {
    pendingMatches.shift();
  }
}

// Trim and truncate line content for storage
function prepareTrimmedLine(line: string): string {
  return line.trim().substring(0, MAX_LINE_CONTENT_LENGTH);
}

// Prepare final search pattern with optional literal escaping and word boundaries
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
  // Simple array for context lines (contextLines is capped at 0-10)
  const contextBuffer: string[] = [];
  const pendingMatches: PendingMatch[] = [];

  try {
    for await (const line of rl) {
      lineNumber++;

      if (deadlineMs !== undefined && Date.now() > deadlineMs) break;
      if (currentMatchCount + matches.length >= maxResults) break;

      const trimmedLine = prepareTrimmedLine(line);
      updatePendingMatches(pendingMatches, trimmedLine);

      // Use fast path for literal searches
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

      // Update context buffer
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
