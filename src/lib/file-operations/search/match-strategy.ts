import RE2 from 're2';
import safeRegex from 'safe-regex2';

import { REGEX_MATCH_TIMEOUT_MS } from '../../constants.js';
import { ErrorCode, McpError } from '../../errors.js';

export type Matcher = (line: string) => number;
interface RegExpLike {
  exec: (line: string) => RegExpExecArray | null;
  lastIndex: number;
}

export function createMatcher(
  pattern: string,
  options: {
    isLiteral: boolean;
    wholeWord: boolean;
    caseSensitive: boolean;
    basePath: string;
  }
): Matcher {
  const { isLiteral, wholeWord, caseSensitive, basePath } = options;

  if (isLiteral && !wholeWord) {
    return createLiteralMatcher(pattern, caseSensitive);
  }

  // Regex matcher
  const finalPattern = preparePattern(pattern, isLiteral, wholeWord);

  ensureSafePattern(finalPattern, pattern, basePath);

  const regex = compileRegex(finalPattern, caseSensitive, basePath);
  return createRegexMatcher(regex);
}

function createLiteralMatcher(
  pattern: string,
  caseSensitive: boolean
): Matcher {
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  const haystackTransform = caseSensitive
    ? (s: string) => s
    : (s: string) => s.toLowerCase();

  return (line: string): number => {
    if (line.length === 0 || needle.length === 0) return 0;

    const haystack = haystackTransform(line);
    let count = 0;
    let pos = 0;

    while ((pos = haystack.indexOf(needle, pos)) !== -1) {
      count++;
      pos += needle.length;
    }

    return count;
  };
}

function createRegexMatcher(
  regex: RegExpLike,
  timeoutMs: number = REGEX_MATCH_TIMEOUT_MS
): Matcher {
  return (line: string): number => countRegexMatches(line, regex, timeoutMs);
}

function countRegexMatches(
  line: string,
  regex: RegExpLike,
  timeoutMs: number
): number {
  if (line.length === 0) return 0;
  regex.lastIndex = 0;

  const deadline = Date.now() + timeoutMs;
  const maxIterations = Math.min(line.length * 2, 10000);
  return runRegexMatchLoop(line, regex, deadline, maxIterations);
}

function runRegexMatchLoop(
  line: string,
  regex: RegExpLike,
  deadline: number,
  maxIterations: number
): number {
  let count = 0;
  let iterations = 0;
  let lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    count++;
    iterations++;

    const advance = advanceRegexIndex(match, regex, lastIndex);
    if (advance.shouldAbort) return -1;
    lastIndex = advance.nextLastIndex;

    if (shouldCheckTimeout(count, iterations, deadline, maxIterations)) {
      return -1;
    }
  }

  return count;
}

function advanceRegexIndex(
  match: RegExpExecArray,
  regex: RegExpLike,
  lastIndex: number
): { nextLastIndex: number; shouldAbort: boolean } {
  let nextIndex = regex.lastIndex;
  if (match[0] === '') {
    nextIndex = regex.lastIndex + 1;
    regex.lastIndex = nextIndex;
  }
  if (nextIndex <= lastIndex) {
    return { nextLastIndex: lastIndex, shouldAbort: true };
  }
  return { nextLastIndex: nextIndex, shouldAbort: false };
}

function shouldCheckTimeout(
  count: number,
  iterations: number,
  deadline: number,
  maxIterations: number
): boolean {
  if (iterations > maxIterations) return true;
  if (!isCheckInterval(count, iterations)) return false;
  return Date.now() > deadline;
}

function isCheckInterval(count: number, iterations: number): boolean {
  const countInterval = count > 0 && count % 10 === 0;
  const iterationInterval = iterations > 0 && iterations % 50 === 0;
  return countInterval || iterationInterval;
}

function preparePattern(
  pattern: string,
  isLiteral: boolean,
  wholeWord: boolean
): string {
  let finalPattern = pattern;

  if (isLiteral) {
    finalPattern = finalPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  if (wholeWord) {
    finalPattern = `\\b${finalPattern}\\b`;
  }

  return finalPattern;
}

function ensureSafePattern(
  finalPattern: string,
  originalPattern: string,
  basePath: string
): void {
  if (safeRegex(finalPattern)) return;

  throw new McpError(
    ErrorCode.E_INVALID_PATTERN,
    `Potentially unsafe regular expression (ReDoS risk): ${originalPattern}. ` +
      'Avoid patterns with nested quantifiers, overlapping alternations, or exponential backtracking.',
    basePath,
    { reason: 'ReDoS risk detected' }
  );
}

function compileRegex(
  pattern: string,
  caseSensitive: boolean,
  basePath: string
): RegExpLike {
  try {
    return new RE2(pattern, caseSensitive ? 'g' : 'gi');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpError(
      ErrorCode.E_INVALID_PATTERN,
      `Invalid regular expression: ${pattern} (${message})`,
      basePath,
      { searchPattern: pattern }
    );
  }
}
