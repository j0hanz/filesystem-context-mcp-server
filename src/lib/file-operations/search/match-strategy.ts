import safeRegex from 'safe-regex2';

import { REGEX_MATCH_TIMEOUT_MS } from '../../constants.js';
import { ErrorCode, McpError } from '../../errors.js';

export interface MatchStrategy {
  countMatches(line: string): number;
  isValid(): boolean;
}

export class LiteralMatchStrategy implements MatchStrategy {
  private readonly needle: string;
  private readonly haystackTransform: (s: string) => string;

  constructor(pattern: string, caseSensitive: boolean) {
    this.needle = caseSensitive ? pattern : pattern.toLowerCase();
    this.haystackTransform = caseSensitive ? (s) => s : (s) => s.toLowerCase();
  }

  countMatches(line: string): number {
    if (line.length === 0 || this.needle.length === 0) return 0;

    const haystack = this.haystackTransform(line);
    let count = 0;
    let pos = 0;

    while ((pos = haystack.indexOf(this.needle, pos)) !== -1) {
      count++;
      pos += this.needle.length;
    }

    return count;
  }

  isValid(): boolean {
    return true;
  }
}

export class RegexMatchStrategy implements MatchStrategy {
  private readonly regex: RegExp;
  private readonly timeoutMs: number;

  constructor(regex: RegExp, timeoutMs: number = REGEX_MATCH_TIMEOUT_MS) {
    this.regex = regex;
    this.timeoutMs = timeoutMs;
  }

  countMatches(line: string): number {
    if (line.length === 0) return 0;

    this.regex.lastIndex = 0;
    let count = 0;
    const deadline = Date.now() + this.timeoutMs;
    const maxIterations = Math.min(line.length * 2, 10000);
    let iterations = 0;
    let lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = this.regex.exec(line)) !== null) {
      count++;
      iterations++;

      const { lastIndex: currentIndex } = this.regex;
      if (match[0] === '') {
        this.regex.lastIndex++;
      }
      if (currentIndex === lastIndex) {
        return -1; // Infinite loop protection
      }
      ({ lastIndex } = this.regex);

      if (this.shouldCheckTimeout(count, iterations, deadline, maxIterations)) {
        return -1;
      }
    }

    return count;
  }

  isValid(): boolean {
    return true;
  }

  private shouldCheckTimeout(
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
}

export function createMatchStrategy(
  pattern: string,
  options: {
    isLiteral: boolean;
    wholeWord: boolean;
    caseSensitive: boolean;
    basePath: string;
  }
): MatchStrategy {
  const { isLiteral, wholeWord, caseSensitive, basePath } = options;

  if (isLiteral && !wholeWord) {
    return new LiteralMatchStrategy(pattern, caseSensitive);
  }

  // For wholeWord or regex, we use RegexStrategy
  const finalPattern = preparePattern(pattern, isLiteral, wholeWord);
  const needsReDoSCheck = !isLiteral && !isSimpleSafePattern(finalPattern);

  ensureSafePattern(finalPattern, pattern, basePath, needsReDoSCheck);

  const regex = compileRegex(finalPattern, caseSensitive, basePath);
  return new RegexMatchStrategy(regex);
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
