import safeRegex from 'safe-regex2';

import { REGEX_MATCH_TIMEOUT_MS } from '../../constants.js';
import { ErrorCode, McpError } from '../../errors.js';

export type Matcher = (line: string) => number;

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
  const needsReDoSCheck = !isLiteral && !isSimpleSafePattern(finalPattern);

  ensureSafePattern(finalPattern, pattern, basePath, needsReDoSCheck);

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
  regex: RegExp,
  timeoutMs: number = REGEX_MATCH_TIMEOUT_MS
): Matcher {
  return (line: string): number => {
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
        return -1; // Infinite loop protection
      }
      ({ lastIndex } = regex);

      if (shouldCheckTimeout(count, iterations, deadline, maxIterations)) {
        return -1;
      }
    }

    return count;
  };
}

function shouldCheckTimeout(
  count: number,
  iterations: number,
  deadline: number,
  maxIterations: number
): boolean {
  const shouldCheck =
    (count > 0 && count % 10 === 0) ||
    (iterations > 0 && iterations % 50 === 0);

  return (shouldCheck && Date.now() > deadline) || iterations > maxIterations;
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

function ensureSafePattern(
  finalPattern: string,
  originalPattern: string,
  basePath: string,
  needsReDoSCheck: boolean
): void {
  if (!needsReDoSCheck || safeRegex(finalPattern)) return;

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
): RegExp {
  try {
    return new RegExp(pattern, caseSensitive ? 'g' : 'gi');
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
