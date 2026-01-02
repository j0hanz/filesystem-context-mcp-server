import * as fsp from 'node:fs/promises';
import readline from 'node:readline';

import RE2 from 're2';
import safeRegex from 'safe-regex2';

import type { ContentMatch } from '../../../config/types.js';
import { MAX_LINE_CONTENT_LENGTH } from '../../constants.js';
import { isProbablyBinary } from '../../fs-helpers.js';

export interface MatcherOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  isLiteral: boolean;
}

export type Matcher = (line: string) => number;

export interface ScanFileOptions {
  maxFileSize: number;
  skipBinary: boolean;
  contextLines: number;
}

export interface ScanFileResult {
  matches: ContentMatch[];
  matched: boolean;
  skippedTooLarge: boolean;
  skippedBinary: boolean;
}

export function buildMatcher(
  pattern: string,
  options: MatcherOptions
): Matcher {
  if (options.isLiteral && !options.wholeWord) {
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

  const escaped = options.isLiteral
    ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : pattern;
  const final = options.wholeWord ? `\\b${escaped}\\b` : escaped;
  if (!safeRegex(final)) {
    throw new Error(
      `Potentially unsafe regular expression (ReDoS risk): ${pattern}`
    );
  }
  const regex = new RE2(final, options.caseSensitive ? 'g' : 'gi');
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

export async function scanFileResolved(
  resolvedPath: string,
  requestedPath: string,
  matcher: Matcher,
  options: ScanFileOptions,
  signal?: AbortSignal,
  maxMatches: number = Number.POSITIVE_INFINITY
): Promise<ScanFileResult> {
  const handle = await fsp.open(resolvedPath, 'r');

  try {
    const stats = await handle.stat();

    if (stats.size > options.maxFileSize) {
      return {
        matches: [],
        matched: false,
        skippedTooLarge: true,
        skippedBinary: false,
      };
    }

    if (options.skipBinary) {
      const binary = await isProbablyBinary(resolvedPath, handle, signal);
      if (binary) {
        return {
          matches: [],
          matched: false,
          skippedTooLarge: false,
          skippedBinary: true,
        };
      }
    }

    const rl = readline.createInterface({
      input: handle.createReadStream({ encoding: 'utf-8', autoClose: false }),
      crlfDelay: Infinity,
      signal,
    });

    const ctx = makeContext();
    const matches: ContentMatch[] = [];
    let lineNo = 0;
    try {
      for await (const line of rl) {
        if (signal?.aborted) break;
        lineNo++;
        pushContext(ctx, trimContent(line), options.contextLines);

        const count = matcher(line);
        if (count > 0) {
          const match: ContentMatch = {
            file: requestedPath,
            line: lineNo,
            content: trimContent(line),
            contextBefore:
              options.contextLines > 0 ? [...ctx.before] : undefined,
            matchCount: count,
          };
          matches.push(match);
          if (options.contextLines > 0) {
            ctx.pendingAfter.push({ match, left: options.contextLines });
          }
        }

        if (matches.length >= maxMatches) {
          break;
        }
      }
    } finally {
      rl.close();
    }

    return {
      matches,
      matched: matches.length > 0,
      skippedTooLarge: false,
      skippedBinary: false,
    };
  } finally {
    await handle.close();
  }
}
