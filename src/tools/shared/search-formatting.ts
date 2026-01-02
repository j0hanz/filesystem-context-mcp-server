import * as pathModule from 'node:path';

import type { z } from 'zod';

import { formatOperationSummary, joinLines } from '../../config/formatting.js';
import type { SearchContentResult } from '../../config/types.js';
import type { SearchContentOutputSchema } from '../../schemas/index.js';

type SearchContentStructuredResult = z.infer<typeof SearchContentOutputSchema>;

const LINE_NUMBER_PAD_WIDTH = 4;

type NormalizedMatch = SearchContentResult['matches'][number] & {
  relativeFile: string;
  index: number;
};

function normalizeMatches(result: SearchContentResult): NormalizedMatch[] {
  const normalized = result.matches.map((match, index) => ({
    ...match,
    relativeFile: pathModule.relative(result.basePath, match.file),
    index,
  }));

  normalized.sort((a, b) => {
    const fileCompare = a.relativeFile.localeCompare(b.relativeFile);
    if (fileCompare !== 0) return fileCompare;
    if (a.line !== b.line) return a.line - b.line;
    return a.index - b.index;
  });

  return normalized;
}

function groupMatchesByFile(
  matches: NormalizedMatch[]
): Map<string, NormalizedMatch[]> {
  const byFile = new Map<string, NormalizedMatch[]>();
  for (const match of matches) {
    const list = byFile.get(match.relativeFile) ?? [];
    list.push(match);
    byFile.set(match.relativeFile, list);
  }
  return byFile;
}

function formatContextLines(
  context: readonly string[] | undefined,
  startLine: number
): string[] {
  return (context ?? []).map(
    (line, idx) =>
      `    ${String(startLine + idx).padStart(LINE_NUMBER_PAD_WIDTH)}: ${line}`
  );
}

function formatMatchBlock(
  match: SearchContentResult['matches'][number]
): string[] {
  const before = formatContextLines(
    match.contextBefore,
    match.line - (match.contextBefore?.length ?? 0)
  );
  const after = formatContextLines(match.contextAfter, match.line + 1);
  const lines = [
    ...before,
    `  > ${String(match.line).padStart(LINE_NUMBER_PAD_WIDTH)}: ${match.content}`,
    ...after,
  ];
  if (before.length || after.length) lines.push('    ---');
  return lines;
}

function formatFileMatches(file: string, matches: NormalizedMatch[]): string[] {
  const matchCount = matches.reduce((sum, m) => sum + m.matchCount, 0);
  const lines: string[] = [
    `${file} (${matchCount} match${matchCount === 1 ? '' : 'es'}):`,
  ];
  for (const match of matches) {
    lines.push(...formatMatchBlock(match));
  }
  lines.push('');
  return lines;
}

function formatContentMatches(matches: NormalizedMatch[]): string {
  if (matches.length === 0) return 'No matches';

  const byFile = groupMatchesByFile(matches);
  const lines: string[] = [`Found ${matches.length}:`];
  for (const [file, fileMatches] of byFile) {
    lines.push(...formatFileMatches(file, fileMatches));
  }

  return joinLines(lines);
}

export function buildStructuredResult(
  result: SearchContentResult
): SearchContentStructuredResult {
  const { basePath, pattern, filePattern, summary } = result;
  const normalizedMatches = normalizeMatches(result);
  return {
    ok: true,
    basePath,
    pattern,
    filePattern,
    matches: normalizedMatches.map((m) => ({
      file: m.relativeFile,
      line: m.line,
      content: m.content,
      contextBefore: m.contextBefore ? [...m.contextBefore] : undefined,
      contextAfter: m.contextAfter ? [...m.contextAfter] : undefined,
      matchCount: m.matchCount,
    })),
    summary: {
      filesScanned: summary.filesScanned,
      filesMatched: summary.filesMatched,
      totalMatches: summary.matches,
      truncated: summary.truncated,
      skippedTooLarge: summary.skippedTooLarge || undefined,
      skippedBinary: summary.skippedBinary || undefined,
      skippedInaccessible: summary.skippedInaccessible || undefined,
      linesSkippedDueToRegexTimeout:
        summary.linesSkippedDueToRegexTimeout || undefined,
      stoppedReason: summary.stoppedReason,
    },
  };
}

function buildTruncationInfo(result: SearchContentResult): {
  truncatedReason?: string;
  tip?: string;
} {
  if (!result.summary.truncated) return {};
  if (result.summary.stoppedReason === 'timeout') {
    return {
      truncatedReason: 'search timed out',
      tip: 'Increase timeoutMs, use more specific filePattern, or add excludePatterns to narrow scope.',
    };
  }
  if (result.summary.stoppedReason === 'maxResults') {
    return {
      truncatedReason: `reached max results limit (${result.summary.matches})`,
    };
  }
  if (result.summary.stoppedReason === 'maxFiles') {
    return {
      truncatedReason: `reached max files limit (${result.summary.filesScanned} scanned)`,
    };
  }
  return {};
}

export function buildTextResult(result: SearchContentResult): string {
  const { summary } = result;
  const { truncatedReason, tip } = buildTruncationInfo(result);
  const header = joinLines([
    `Base path: ${result.basePath}`,
    `Pattern: ${result.pattern}`,
    `File pattern: ${result.filePattern}`,
  ]);
  const normalizedMatches = normalizeMatches(result);
  let textOutput = joinLines([header, formatContentMatches(normalizedMatches)]);
  textOutput += formatOperationSummary({
    truncated: summary.truncated,
    truncatedReason,
    tip,
    skippedTooLarge: summary.skippedTooLarge,
    skippedBinary: summary.skippedBinary,
    skippedInaccessible: summary.skippedInaccessible,
    linesSkippedDueToRegexTimeout: summary.linesSkippedDueToRegexTimeout,
  });

  if (summary.truncated && !tip) {
    textOutput += `\nScanned ${summary.filesScanned} files, found ${summary.matches} matches in ${summary.filesMatched} files.`;
  }

  return textOutput;
}
