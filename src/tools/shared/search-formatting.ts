import * as pathModule from 'node:path';

import type { z } from 'zod';

import { formatOperationSummary, joinLines } from '../../config/formatting.js';
import type { SearchContentResult } from '../../config/types.js';
import type { SearchContentOutputSchema } from '../../schemas/index.js';

type SearchContentStructuredResult = z.infer<typeof SearchContentOutputSchema>;

const LINE_NUMBER_PAD_WIDTH = 4;

function groupMatchesByFile(
  matches: SearchContentResult['matches']
): Map<string, SearchContentResult['matches']> {
  const byFile = new Map<string, SearchContentResult['matches']>();
  for (const match of matches) {
    const list = byFile.get(match.file) ?? [];
    list.push(match);
    byFile.set(match.file, list);
  }
  return byFile;
}

function formatContextLines(
  context: string[] | undefined,
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

function formatFileMatches(
  file: string,
  matches: SearchContentResult['matches']
): string[] {
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

function formatContentMatches(matches: SearchContentResult['matches']): string {
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
  const { basePath, pattern, filePattern, matches, summary } = result;
  return {
    ok: true,
    basePath,
    pattern,
    filePattern,
    matches: matches.map((m) => ({
      file: pathModule.relative(basePath, m.file),
      line: m.line,
      content: m.content,
      contextBefore: m.contextBefore,
      contextAfter: m.contextAfter,
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
  let textOutput = formatContentMatches(result.matches);
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
