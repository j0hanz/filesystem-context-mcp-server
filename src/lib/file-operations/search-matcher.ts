import { z } from 'zod';

import RE2 from 're2';
import safeRegex from 'safe-regex2';

export const MatcherOptionsSchema = z.strictObject({
  caseSensitive: z.boolean(),
  wholeWord: z.boolean(),
  isLiteral: z.boolean(),
});
export type MatcherOptions = z.infer<typeof MatcherOptionsSchema>;

export type Matcher = (line: string) => number;

interface RegexLikeMatcher {
  lastIndex: number;
  exec(input: string): unknown;
}

function countRegexLineMatches(regex: RegexLikeMatcher, line: string): number {
  regex.lastIndex = 0;
  let count = 0;
  while (regex.exec(line) !== null) {
    count++;
    if (regex.lastIndex === 0) regex.lastIndex++;
  }
  return count;
}

function escapeLiteral(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegexPattern(pattern: string, options: MatcherOptions): string {
  const escaped = options.isLiteral ? escapeLiteral(pattern) : pattern;
  return options.wholeWord ? `\\b${escaped}\\b` : escaped;
}

export function validatePattern(
  pattern: string,
  options: MatcherOptions
): void {
  if (options.isLiteral && pattern.length === 0) return;
  if (options.isLiteral && !options.wholeWord) return;

  const final = buildRegexPattern(pattern, options);
  if (!safeRegex(final)) {
    throw new Error(
      `Potentially unsafe regular expression (ReDoS risk): ${pattern}`
    );
  }
}

function buildLiteralMatcher(
  pattern: string,
  options: MatcherOptions
): Matcher {
  if (!options.caseSensitive) {
    const final = escapeLiteral(pattern);
    const regex = new RegExp(final, 'gi');
    return (line: string): number => countRegexLineMatches(regex, line);
  }

  // Fast path for case-sensitive literal
  const needle = pattern;
  if (needle.length === 0) return () => 0;

  return (line: string): number => {
    if (line.length === 0) return 0;

    let count = 0;
    let pos = line.indexOf(needle);
    while (pos !== -1) {
      count++;
      pos = line.indexOf(needle, pos + needle.length);
    }
    return count;
  };
}

function buildRegexMatcher(final: string, caseSensitive: boolean): Matcher {
  const regex = new RE2(final, caseSensitive ? 'g' : 'gi');
  return (line: string): number => countRegexLineMatches(regex, line);
}

export function buildMatcher(
  pattern: string,
  options: MatcherOptions
): Matcher {
  if (options.isLiteral && pattern.length === 0) return () => 0;

  if (options.isLiteral && !options.wholeWord) {
    // fast path for simple literal search
    return buildLiteralMatcher(pattern, options);
  }

  const final = buildRegexPattern(pattern, options);
  validatePattern(pattern, options); // Re-validate to be safe
  return buildRegexMatcher(final, options.caseSensitive);
}
