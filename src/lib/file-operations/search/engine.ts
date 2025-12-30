import * as fsp from 'node:fs/promises';
import readline from 'node:readline';

import RE2 from 're2';
import safeRegex from 'safe-regex2';

import type {
  ContentMatch,
  SearchContentResult,
} from '../../../config/types.js';
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_LINE_CONTENT_LENGTH,
  MAX_SEARCHABLE_FILE_SIZE,
} from '../../constants.js';
import { createTimedAbortSignal, isProbablyBinary } from '../../fs-helpers.js';
import {
  validateExistingDirectory,
  validateExistingPathDetailed,
} from '../../path-validation.js';
import { globEntries } from '../glob-engine.js';

export interface SearchOptions {
  filePattern: string;
  excludePatterns: string[];
  caseSensitive: boolean;
  maxResults: number;
  maxFileSize: number;
  maxFilesScanned: number;
  timeoutMs: number;
  skipBinary: boolean;
  contextLines: number;
  wholeWord: boolean;
  isLiteral: boolean;
  includeHidden: boolean;
  baseNameMatch: boolean;
  caseSensitiveFileMatch: boolean;
}

export interface SearchContentOptions extends Partial<SearchOptions> {
  signal?: AbortSignal;
}

type Matcher = (line: string) => number;

type ResolvedOptions = SearchOptions;

const DEFAULTS: SearchOptions = {
  filePattern: '**/*',
  excludePatterns: [],
  caseSensitive: false,
  maxResults: DEFAULT_MAX_RESULTS,
  maxFileSize: MAX_SEARCHABLE_FILE_SIZE,
  maxFilesScanned: DEFAULT_SEARCH_MAX_FILES,
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  skipBinary: true,
  contextLines: 0,
  wholeWord: false,
  isLiteral: false,
  includeHidden: false,
  baseNameMatch: false,
  caseSensitiveFileMatch: true,
};

function mergeOptions(partial: SearchContentOptions): ResolvedOptions {
  const { signal, ...rest } = partial;
  void signal; // signal handled externally via createTimedAbortSignal
  const merged: ResolvedOptions = { ...DEFAULTS, ...rest };
  return merged;
}

function buildMatcher(pattern: string, o: ResolvedOptions): Matcher {
  if (o.isLiteral && !o.wholeWord) {
    const needle = o.caseSensitive ? pattern : pattern.toLowerCase();
    return (line: string): number => {
      const hay = o.caseSensitive ? line : line.toLowerCase();
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

  const escaped = o.isLiteral
    ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : pattern;
  const final = o.wholeWord ? `\\b${escaped}\\b` : escaped;
  if (!safeRegex(final)) {
    throw new Error(
      `Potentially unsafe regular expression (ReDoS risk): ${pattern}`
    );
  }
  const regex = new RE2(final, o.caseSensitive ? 'g' : 'gi');
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

interface ContextState {
  before: string[];
  pendingAfter: { match: ContentMatch; left: number }[];
}

function makeContext(): ContextState {
  return { before: [], pendingAfter: [] };
}

function pushContext(ctx: ContextState, line: string, max: number): void {
  if (max <= 0) return;
  ctx.before.push(line);
  if (ctx.before.length > max) ctx.before.shift();
  for (const pending of ctx.pendingAfter) {
    if (pending.left <= 0) continue;
    pending.match.contextAfter ??= [];
    pending.match.contextAfter.push(line);
    pending.left -= 1;
  }
  while (ctx.pendingAfter.length > 0 && ctx.pendingAfter[0]?.left === 0) {
    ctx.pendingAfter.shift();
  }
}

function trimContent(line: string): string {
  return line.trimEnd().slice(0, MAX_LINE_CONTENT_LENGTH);
}

async function scanFile(
  targetPath: string,
  matcher: Matcher,
  opts: ResolvedOptions,
  summary: SearchContentResult['summary'],
  matches: ContentMatch[],
  signal: AbortSignal
): Promise<void> {
  const { resolvedPath, requestedPath } = await validateExistingPathDetailed(
    targetPath,
    signal
  );
  const handle = await fsp.open(resolvedPath, 'r');
  const stats = await handle.stat();

  if (stats.size > opts.maxFileSize) {
    summary.skippedTooLarge++;
    await handle.close();
    return;
  }

  if (
    opts.skipBinary &&
    (await isProbablyBinary(resolvedPath, handle, signal))
  ) {
    summary.skippedBinary++;
    await handle.close();
    return;
  }

  const rl = readline.createInterface({
    input: handle.createReadStream({ encoding: 'utf-8', autoClose: false }),
    crlfDelay: Infinity,
    signal,
  });

  const ctx = makeContext();
  let lineNo = 0;
  try {
    for await (const line of rl) {
      if (signal.aborted) break;
      lineNo++;
      pushContext(ctx, trimContent(line), opts.contextLines);

      if (matches.length >= opts.maxResults) {
        summary.truncated = true;
        summary.stoppedReason = 'maxResults';
        break;
      }

      const count = matcher(line);
      if (count > 0) {
        const match: ContentMatch = {
          file: requestedPath,
          line: lineNo,
          content: trimContent(line),
          contextBefore: opts.contextLines > 0 ? [...ctx.before] : undefined,
          matchCount: count,
        };
        matches.push(match);
        if (opts.contextLines > 0) {
          ctx.pendingAfter.push({ match, left: opts.contextLines });
        }
      }
    }
  } finally {
    rl.close();
    await handle.close();
  }

  if (matches.length > 0) {
    summary.filesMatched++;
  }
}

export async function searchContent(
  basePath: string,
  pattern: string,
  options: SearchContentOptions = {}
): Promise<SearchContentResult> {
  const opts = mergeOptions(options);
  const { signal, cleanup } = createTimedAbortSignal(
    options.signal,
    opts.timeoutMs
  );
  const root = await validateExistingDirectory(basePath, signal);
  const matcher = buildMatcher(pattern, opts);

  const summary: SearchContentResult['summary'] = {
    filesScanned: 0,
    filesMatched: 0,
    matches: 0,
    truncated: false,
    skippedTooLarge: 0,
    skippedBinary: 0,
    skippedInaccessible: 0,
    linesSkippedDueToRegexTimeout: 0,
    stoppedReason: undefined,
  };

  const matches: ContentMatch[] = [];

  try {
    const stream = globEntries({
      cwd: root,
      pattern: opts.filePattern,
      excludePatterns: opts.excludePatterns,
      includeHidden: opts.includeHidden,
      baseNameMatch: opts.baseNameMatch,
      caseSensitiveMatch: opts.caseSensitiveFileMatch,
      followSymbolicLinks: false,
      onlyFiles: false,
      stats: true,
      suppressErrors: true,
    });

    for await (const entry of stream) {
      if (signal.aborted) {
        summary.truncated = true;
        summary.stoppedReason = 'timeout';
        break;
      }
      if (summary.filesScanned >= opts.maxFilesScanned) {
        summary.truncated = true;
        summary.stoppedReason = 'maxFiles';
        break;
      }
      summary.filesScanned++;

      try {
        await scanFile(entry.path, matcher, opts, summary, matches, signal);
      } catch {
        summary.skippedInaccessible++;
      }

      summary.matches = matches.length;
      if (matches.length >= opts.maxResults) {
        summary.truncated = true;
        summary.stoppedReason = 'maxResults';
        break;
      }
    }

    return {
      basePath: root,
      pattern,
      filePattern: opts.filePattern,
      matches,
      summary,
    };
  } finally {
    cleanup();
  }
}
