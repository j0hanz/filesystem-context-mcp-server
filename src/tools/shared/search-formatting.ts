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

function normalizeMatches(result: SearchContentResult): NormalizedMatch[] {
  const { basePath, matches } = result;
  const relativeByFile = new Map<string, string>();
  const normalized: NormalizedMatch[] = [];

  let index = 0;
  for (const match of matches) {
    const { file, line, content, contextBefore, contextAfter, matchCount } =
      match;

    let relativeFile = relativeByFile.get(file);
    if (relativeFile === undefined) {
      relativeFile = pathModule.relative(basePath, file);
      relativeByFile.set(file, relativeFile);
    }

    normalized.push({
      file,
      line,
      content,
      contextBefore,
      contextAfter,
      matchCount,
      relativeFile,
      index,
    });

    index++;
  }

  normalized.sort((a, b) => {
    const fileCompare = a.relativeFile.localeCompare(b.relativeFile);
    if (fileCompare !== 0) return fileCompare;
    if (a.line !== b.line) return a.line - b.line;
    return a.index - b.index;
  });

  return normalized;
}

function formatMatchLine(match: NormalizedMatch): string {
  const lineNum = String(match.line).padStart(LINE_NUMBER_PAD_WIDTH);
  return `  ${match.relativeFile}:${lineNum}: ${match.content}`;
}

function buildStructuredMatches(
  matches: NormalizedMatch[]
): SearchContentStructuredResult['matches'] {
  return matches.map((match) => ({
    file: match.relativeFile,
    line: match.line,
    content: match.content,
    contextBefore: match.contextBefore ? [...match.contextBefore] : undefined,
    contextAfter: match.contextAfter ? [...match.contextAfter] : undefined,
  }));
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

  return (
    joinLines([
      `Found ${normalizedMatches.length}:`,
      ...normalizedMatches.map(formatMatchLine),
    ]) +
    formatOperationSummary({ truncated: summary.truncated, truncatedReason })
  );
}
