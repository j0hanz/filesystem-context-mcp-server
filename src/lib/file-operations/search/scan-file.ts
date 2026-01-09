import RE2 from 're2';
import safeRegex from 'safe-regex2';

import { isProbablyBinary } from '../../fs-helpers/binary-detect.js';
import { scanFileWithMatcher } from './scan-runner.js';
import type {
  Matcher,
  MatcherOptions,
  ScanFileOptions,
  ScanFileResult,
} from './scan-types.js';

export type { Matcher, MatcherOptions, ScanFileOptions } from './scan-types.js';

/**
 * Validate a search pattern for safety (ReDoS protection).
 * Throws an error if the pattern is unsafe.
 * Call this before sending patterns to workers.
 */
export function validatePattern(
  pattern: string,
  options: MatcherOptions
): void {
  // Literal patterns without wholeWord don't use regex, always safe
  if (options.isLiteral && !options.wholeWord) {
    return;
  }

  const final = buildRegexPattern(pattern, options);
  assertSafePattern(final, pattern);
}

function escapeLiteral(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegexPattern(pattern: string, options: MatcherOptions): string {
  const escaped = options.isLiteral ? escapeLiteral(pattern) : pattern;
  return options.wholeWord ? `\\b${escaped}\\b` : escaped;
}

function assertSafePattern(final: string, original: string): void {
  if (!safeRegex(final)) {
    throw new Error(
      `Potentially unsafe regular expression (ReDoS risk): ${original}`
    );
  }
}

function buildLiteralMatcher(
  pattern: string,
  options: MatcherOptions
): Matcher {
  const needle = options.caseSensitive ? pattern : pattern.toLowerCase();
  return (line: string): number => {
    const hay = options.caseSensitive ? line : line.toLowerCase();
    if (needle.length === 0 || hay.length === 0) return 0;
    let count = 0;
    let pos = hay.indexOf(needle);
    while (pos !== -1) {
      count++;
      pos = hay.indexOf(needle, pos + needle.length);
    }
    return count;
  };
}

function buildRegexMatcher(final: string, caseSensitive: boolean): Matcher {
  const regex = new RE2(final, caseSensitive ? 'g' : 'gi');
  return (line: string): number => {
    regex.lastIndex = 0;
    let count = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      count++;
      if (match[0].length === 0) {
        regex.lastIndex++;
      }
    }
    return count;
  };
}

export function buildMatcher(
  pattern: string,
  options: MatcherOptions
): Matcher {
  if (options.isLiteral && !options.wholeWord && !options.caseSensitive) {
    if (pattern.length === 0) {
      return (): number => 0;
    }

    return buildRegexMatcher(escapeLiteral(pattern), false);
  }

  if (options.isLiteral && !options.wholeWord) {
    return buildLiteralMatcher(pattern, options);
  }

  const final = buildRegexPattern(pattern, options);
  assertSafePattern(final, pattern);
  return buildRegexMatcher(final, options.caseSensitive);
}

export async function scanFileResolved(
  resolvedPath: string,
  requestedPath: string,
  matcher: Matcher,
  options: ScanFileOptions,
  signal?: AbortSignal,
  maxMatches: number = Number.POSITIVE_INFINITY
): Promise<ScanFileResult> {
  const scanOptions: Parameters<typeof scanFileWithMatcher>[2] = {
    matcher,
    options,
    maxMatches,
    isCancelled: () => Boolean(signal?.aborted),
    isProbablyBinary,
  };
  if (signal) {
    scanOptions.signal = signal;
  }
  return scanFileWithMatcher(resolvedPath, requestedPath, scanOptions);
}
