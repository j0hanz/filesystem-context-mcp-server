import { stat as fsStat, readFile } from 'node:fs/promises';

import { buildGlobOptions, globEntries } from '../glob.js';
import type { PathGuard } from '../path.js';
import { escapeRegexLiteral } from '../primitives.js';
import { MAX_TEXT_FILE_SIZE } from '../util.js';

export interface SearchResult {
  file: string;
  line: number;
  content: string;
  matchCount?: number;
}

export type Regex = RegExp;
export interface RegexCompileOptions {
  caseSensitive?: boolean;
}

/** Occurrence-counting bound, so one pathological line cannot spin forever. */
const MAX_MATCHES_PER_LINE = 100_000;

/**
 * Reject regex constructs that the tool schema documents as unsupported and
 * that widen the ReDoS surface: lookahead, lookbehind, and backreferences.
 * Throws {@link SyntaxError} on the first forbidden construct; the tool layer
 * turns that into a normal tool error.
 */
// ponytail: not a real RE2 engine. We reject the three constructs the schema
// promises are unsupported (lookahead, lookbehind, backreferences). Nested
// quantifiers and other catastrophic-backtracking shapes can still hang V8's
// irregexp synchronously; a real RE2 binding (re2 / re2-wasm) is the upgrade
// path if isRegex is exposed to untrusted clients.
function assertSafeRegex(pattern: string): void {
  // Lookahead / lookbehind: "(?=", "(?!", "(?<=", "(?<!"
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++; // skip the escaped char
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(' && pattern[i + 1] === '?') {
      const next = pattern[i + 2];
      if (next === '=' || next === '!') {
        throw new SyntaxError(`Regex lookahead (?${next}) is not supported; use plain groups.`);
      }
      if (next === '<') {
        const kind = pattern[i + 3];
        if (kind === '=' || kind === '!') {
          throw new SyntaxError(`Regex lookbehind (?<${kind}) is not supported; use plain groups.`);
        }
      }
    }
  }

  // Backreferences outside a character class: numeric \1..\9 and named \k<name>.
  inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      const next = pattern[i + 1];
      if (next !== undefined && !inClass) {
        if (next >= '1' && next <= '9') {
          throw new SyntaxError(
            `Regex backreference \\${next} is not supported; avoid capture-group reuse.`,
          );
        }
        if (next === 'k' && pattern[i + 2] === '<') {
          throw new SyntaxError(
            'Regex named backreference \\k<name> is not supported; avoid capture-group reuse.',
          );
        }
      }
      i++;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
  }
}

export function compileRegex(pattern: string, options: RegexCompileOptions = {}): RegExp {
  assertSafeRegex(pattern);
  const flags = options.caseSensitive ? 'g' : 'gi';
  return new RegExp(pattern, flags);
}

/**
 * Count non-overlapping occurrences of a global regex in a single line. Guards
 * zero-length matches (e.g. `a*`) so they cannot loop forever.
 */
function countLineMatches(regex: RegExp, line: string): number {
  regex.lastIndex = 0;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    count++;
    if (match.index === regex.lastIndex) regex.lastIndex++; // advance past zero-length match
    if (count >= MAX_MATCHES_PER_LINE) break;
  }
  return count;
}

export interface SearchContentOptions {
  caseSensitive?: boolean;
  isRegex?: boolean;
  maxResults?: number;
  filePattern?: string;
  excludePatterns?: string[];
  respectGitignore?: boolean;
  includeHidden?: boolean;
  maxDepth?: number;
  maxFileSize?: number;
  signal?: AbortSignal;
}

export async function searchContent(
  directory: string,
  pattern: string,
  options: SearchContentOptions,
  pathGuard: PathGuard,
): Promise<{
  basePath: string;
  matches: SearchResult[];
  summary: {
    /**
     * Matching *lines*, one per entry in `matches` — not pattern occurrences.
     * A line with three occurrences counts once here and reports 3 in its own
     * `SearchResult.matchCount`.
     */
    matchingLines: number;
    filesScanned: number;
    filesMatched: number;
    truncated: boolean;
    /** Files the guard rejected or that could not be stat'd. */
    skippedInaccessible: number;
    /** Files skipped unread because they exceed maxFileSize. */
    skippedTooLarge: number;
  };
}> {
  const matches: SearchResult[] = [];
  const maxResults = options.maxResults ?? 100;
  const maxFileSize = options.maxFileSize ?? MAX_TEXT_FILE_SIZE;

  const globOpts = buildGlobOptions({
    cwd: directory,
    pattern: options.filePattern ?? '**/*',
    excludePatterns: options.excludePatterns ?? [],
    includeHidden: Boolean(options.includeHidden),
    respectGitignore: Boolean(options.respectGitignore),
    maxDepth: options.maxDepth ?? 100,
  });

  const entries = globEntries(globOpts);

  const regexPattern = options.isRegex ? pattern || '' : escapeRegexLiteral(pattern || '');
  const regex = compileRegex(regexPattern, { caseSensitive: Boolean(options.caseSensitive) });

  let filesScanned = 0;
  let filesMatched = 0;
  let matchingLines = 0;
  let skippedInaccessible = 0;
  let skippedTooLarge = 0;
  // The signal carries both client cancellation and the tool's search timeout,
  // so an abort means "return what we have, marked incomplete" rather than
  // throw — but it must never be reported as a finished scan.
  let stoppedByAbort = false;

  for await (const entry of entries) {
    if (options.signal?.aborted) {
      stoppedByAbort = true;
      break;
    }
    if (matches.length >= maxResults) break;

    if (entry.dirent.isDirectory()) continue;

    // Check if path is allowed
    try {
      await pathGuard.validateExistingPath(entry.path);
    } catch {
      skippedInaccessible++;
      continue;
    }

    // Skip oversized files before reading to avoid unbounded memory use. Count
    // them: "no matches" for a reason other than the pattern must be visible.
    try {
      const stats = await fsStat(entry.path);
      if (stats.size > maxFileSize) {
        skippedTooLarge++;
        continue;
      }
    } catch {
      skippedInaccessible++;
      continue;
    }

    filesScanned++;

    try {
      const content = await readFile(entry.path, { encoding: 'utf-8', signal: options.signal });
      const lines = content.split('\n');
      let matchedFile = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        // One scan per line: countLineMatches resets lastIndex itself, so it
        // doubles as the "does this line match" test.
        const occurrences = countLineMatches(regex, line);
        if (occurrences > 0) {
          matchedFile = true;
          matchingLines++;
          matches.push({
            file: entry.path,
            line: i + 1,
            content: line,
            matchCount: occurrences,
          });
          if (matches.length >= maxResults) break;
        }
      }
      if (matchedFile) filesMatched++;
    } catch {
      // A read failure while the signal is aborted IS the abort, not an
      // unreadable file — stop rather than spend another iteration and then
      // report a cut-short scan as complete.
      if (options.signal?.aborted) {
        stoppedByAbort = true;
        break;
      }
      // ignore read errors (e.g. binary files)
    }
  }

  return {
    basePath: directory,
    matches,
    summary: {
      matchingLines,
      filesScanned,
      filesMatched,
      truncated: stoppedByAbort || matches.length >= maxResults,
      skippedInaccessible,
      skippedTooLarge,
    },
  };
}

export async function searchFiles(
  directory: string,
  pattern: string,
  excludePatterns: string[],
  options: {
    maxResults?: number;
    includeHidden?: boolean;
    sortBy?: 'name' | 'path';
    respectGitignore?: boolean;
    maxDepth?: number;
    signal?: AbortSignal;
  },
  pathGuard: PathGuard,
): Promise<{
  basePath: string;
  results: { path: string }[];
  summary: {
    matched: number;
    filesScanned: number;
    truncated: boolean;
    skippedInaccessible: number;
    stoppedReason?: 'timeout' | 'maxResults';
  };
}> {
  const maxResults = options.maxResults ?? 100;
  const globOpts = buildGlobOptions({
    cwd: directory,
    pattern,
    excludePatterns,
    includeHidden: Boolean(options.includeHidden),
    respectGitignore: Boolean(options.respectGitignore),
    maxDepth: options.maxDepth ?? 100,
  });

  const entries = globEntries(globOpts);
  const results: { path: string }[] = [];
  let filesScanned = 0;
  let skippedInaccessible = 0;
  // As in searchContent: the signal is cancellation OR the tool's search
  // timeout, so an abort returns partial results — but never as a full scan.
  let stoppedByAbort = false;

  for await (const entry of entries) {
    if (options.signal?.aborted) {
      stoppedByAbort = true;
      break;
    }
    if (results.length >= maxResults) break;

    try {
      await pathGuard.validateExistingPath(entry.path);
    } catch {
      skippedInaccessible++;
      continue;
    }

    filesScanned++;
    results.push({ path: entry.path });
  }

  // Sorting — only name / path are supported; size / modified were removed
  // (the glob never collected stats, so they were always undefined).
  if (options.sortBy === 'name') {
    results.sort((a, b) => {
      const aName = a.path.split(/[/\\]/).pop() ?? '';
      const bName = b.path.split(/[/\\]/).pop() ?? '';
      return aName.localeCompare(bName);
    });
  } else {
    results.sort((a, b) => a.path.localeCompare(b.path));
  }

  // maxResults wins over the abort: reaching the cap is the definite cause even
  // if the signal also fired on the iteration that noticed it.
  const hitMaxResults = results.length >= maxResults;
  const stoppedReason = hitMaxResults ? 'maxResults' : stoppedByAbort ? 'timeout' : undefined;

  return {
    basePath: directory,
    results,
    summary: {
      matched: results.length,
      filesScanned,
      truncated: hitMaxResults || stoppedByAbort,
      skippedInaccessible,
      ...(stoppedReason ? { stoppedReason } : {}),
    },
  };
}
