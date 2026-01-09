import * as pathModule from 'node:path';

import type { z } from 'zod';

import { formatOperationSummary, joinLines } from '../../config/formatting.js';
import type { ContentMatch, SearchContentResult } from '../../config/types.js';
import type { SearchContentOutputSchema } from '../../schemas/index.js';

type SearchContentStructuredResult = z.infer<typeof SearchContentOutputSchema>;

const LINE_NUMBER_PAD_WIDTH = 4;

interface NormalizedMatch extends ContentMatch {
  readonly relativeFile: string;
  readonly index: number;
}

function getRelativeFile(
  basePath: string,
  file: string,
  cache: Map<string, string>
): string {
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  const relative = pathModule.relative(basePath, file);
  cache.set(file, relative);
  return relative;
}

function buildNormalizedMatch(
  match: ContentMatch,
  relativeFile: string,
  index: number
): NormalizedMatch {
  const base: NormalizedMatch = {
    file: match.file,
    line: match.line,
    content: match.content,
    matchCount: match.matchCount,
    relativeFile,
    index,
  };
  return {
    ...base,
    ...(match.contextBefore !== undefined
      ? { contextBefore: match.contextBefore }
      : {}),
    ...(match.contextAfter !== undefined
      ? { contextAfter: match.contextAfter }
      : {}),
  };
}

function compareNormalizedMatches(
  a: NormalizedMatch,
  b: NormalizedMatch
): number {
  const fileCompare = a.relativeFile.localeCompare(b.relativeFile);
  if (fileCompare !== 0) return fileCompare;
  if (a.line !== b.line) return a.line - b.line;
  return a.index - b.index;
}

function normalizeMatches(result: SearchContentResult): NormalizedMatch[] {
  const { basePath, matches } = result;
  const relativeByFile = new Map<string, string>();
  const normalized = matches.map((match, index) =>
    buildNormalizedMatch(
      match,
      getRelativeFile(basePath, match.file, relativeByFile),
      index
    )
  );
  normalized.sort(compareNormalizedMatches);
  return normalized;
}

function formatMatchLine(match: NormalizedMatch): string {
  const lineNum = String(match.line).padStart(LINE_NUMBER_PAD_WIDTH);
  return `  ${match.relativeFile}:${lineNum}: ${match.content}`;
}

function buildStructuredMatches(
  matches: NormalizedMatch[]
): SearchContentStructuredResult['matches'] {
  return matches.map((match) => {
    const item: {
      file: string;
      line: number;
      content: string;
      contextBefore?: string[];
      contextAfter?: string[];
    } = {
      file: match.relativeFile,
      line: match.line,
      content: match.content,
    };
    if (match.contextBefore !== undefined) {
      item.contextBefore = [...match.contextBefore];
    }
    if (match.contextAfter !== undefined) {
      item.contextAfter = [...match.contextAfter];
    }
    return item;
  });
}

export function buildStructuredResult(
  result: SearchContentResult
): SearchContentStructuredResult {
  const { summary } = result;
  const normalizedMatches = normalizeMatches(result);
  return {
    ok: true,
    matches: buildStructuredMatches(normalizedMatches),
    totalMatches: summary.matches,
    truncated: summary.truncated,
  };
}

function getTruncatedReason(
  summary: SearchContentResult['summary']
): string | undefined {
  if (!summary.truncated) return undefined;
  if (summary.stoppedReason === 'timeout') return 'timeout';
  return `max results (${summary.matches})`;
}

export function buildTextResult(result: SearchContentResult): string {
  const { summary } = result;
  const normalizedMatches = normalizeMatches(result);

  if (normalizedMatches.length === 0) return 'No matches';

  const truncatedReason = getTruncatedReason(summary);
  const summaryOptions: Parameters<typeof formatOperationSummary>[0] = {
    truncated: summary.truncated,
  };
  if (truncatedReason !== undefined) {
    summaryOptions.truncatedReason = truncatedReason;
  }

  return (
    joinLines([
      `Found ${normalizedMatches.length}:`,
      ...normalizedMatches.map(formatMatchLine),
    ]) + formatOperationSummary(summaryOptions)
  );
}
