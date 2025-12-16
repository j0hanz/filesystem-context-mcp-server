import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';

import type { ContentMatch, ScanFileResult } from '../config/types.js';
import {
  MAX_LINE_CONTENT_LENGTH,
  REGEX_MATCH_TIMEOUT_MS,
} from './constants.js';

// Circular buffer to hold context lines before a match
class CircularLineBuffer {
  private buffer: string[];
  private writeIndex = 0;
  private count = 0;

  constructor(private capacity: number) {
    this.buffer = new Array<string>(capacity);
  }

  push(line: string): void {
    // Defensive truncation (should already be handled by caller)
    const truncatedLine =
      line.length > MAX_LINE_CONTENT_LENGTH
        ? line.substring(0, MAX_LINE_CONTENT_LENGTH)
        : line;
    this.buffer[this.writeIndex] = truncatedLine;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  toArray(): string[] {
    if (this.count === 0) return [];
    if (this.count < this.capacity) {
      return this.buffer.slice(0, this.count);
    }
    // Buffer is full - return in correct order with single allocation
    // Avoids multiple spread/slice allocations for better GC performance
    const result = new Array<string>(this.capacity);
    let writeIdx = 0;
    for (let i = this.writeIndex; i < this.capacity; i++) {
      result[writeIdx++] = this.buffer[i] ?? '';
    }
    for (let i = 0; i < this.writeIndex; i++) {
      result[writeIdx++] = this.buffer[i] ?? '';
    }
    return result;
  }

  clear(): void {
    this.count = 0;
    this.writeIndex = 0;
  }
}

// Pending match tracker for context-after lines
interface PendingMatch {
  match: ContentMatch;
  afterNeeded: number;
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
  }
): Promise<ScanFileResult> {
  const { maxResults, contextLines, deadlineMs, currentMatchCount } = options;
  const matches: ContentMatch[] = [];
  let linesSkippedDueToRegexTimeout = 0;
  let fileHadMatches = false;

  const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  const lineBuffer =
    contextLines > 0 ? new CircularLineBuffer(contextLines) : null;
  const pendingMatches: PendingMatch[] = [];

  try {
    for await (const line of rl) {
      lineNumber++;

      if (deadlineMs !== undefined && Date.now() > deadlineMs) break;
      if (currentMatchCount + matches.length >= maxResults) break;

      const trimmedLine = prepareTrimmedLine(line);
      updatePendingMatches(pendingMatches, trimmedLine);

      const matchCount = countRegexMatches(line, regex);
      if (matchCount < 0) {
        linesSkippedDueToRegexTimeout++;
        lineBuffer?.push(trimmedLine);
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

        const contextBefore = lineBuffer?.toArray();
        if (contextBefore?.length) {
          newMatch.contextBefore = contextBefore;
        }

        matches.push(newMatch);

        if (contextLines > 0) {
          pendingMatches.push({
            match: newMatch,
            afterNeeded: contextLines,
          });
        }
      }

      lineBuffer?.push(trimmedLine);
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }

  return { matches, linesSkippedDueToRegexTimeout, fileHadMatches };
}
