import * as pathModule from 'node:path';

import type { z } from 'zod';

import type { SearchContentResult } from '../../config/types.js';
import type { SearchContentOutputSchema } from '../../schemas/index.js';

type SearchContentStructuredResult = z.infer<typeof SearchContentOutputSchema>;

const LINE_NUMBER_PAD_WIDTH = 4;

function formatContentMatches(matches: SearchContentResult['matches']): string {
  if (matches.length === 0) return 'No matches found';

  const byFile = new Map<string, typeof matches>();
  for (const match of matches) {
    const list = byFile.get(match.file) ?? [];
    list.push(match);
    byFile.set(match.file, list);
  }

  const formatContext = (
    context: string[] | undefined,
    startLine: number
  ): string[] =>
    (context ?? []).map(
      (line, idx) =>
        `    ${String(startLine + idx).padStart(LINE_NUMBER_PAD_WIDTH)}: ${line}`
    );

  const lines: string[] = [`Found ${matches.length} matches:`, ''];
  for (const [file, fileMatches] of byFile) {
    lines.push(`${file}:`);
    for (const match of fileMatches) {
      const before = formatContext(
        match.contextBefore,
        match.line - (match.contextBefore?.length ?? 0)
      );
      const after = formatContext(match.contextAfter, match.line + 1);
      lines.push(...before);
      lines.push(
        `  > ${String(match.line).padStart(LINE_NUMBER_PAD_WIDTH)}: ${
          match.content
        }`
      );
      lines.push(...after);
      if (before.length || after.length) lines.push('    ---');
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatOperationSummary(summary: {
  truncated?: boolean;
  truncatedReason?: string;
  tip?: string;
  skippedInaccessible?: number;
  symlinksNotFollowed?: number;
  skippedTooLarge?: number;
  skippedBinary?: number;
  linesSkippedDueToRegexTimeout?: number;
}): string {
  const lines: string[] = [];
  if (summary.truncated) {
    lines.push(
      `\n\n!! PARTIAL RESULTS: ${summary.truncatedReason ?? 'results truncated'}`
    );
    if (summary.tip) lines.push(`Tip: ${summary.tip}`);
  }
  const note = (count: number | undefined, msg: string): void => {
    if (count && count > 0) lines.push(`Note: ${count} ${msg}`);
  };
  note(summary.skippedTooLarge, 'file(s) skipped (too large).');
  note(summary.skippedBinary, 'file(s) skipped (binary).');
  note(summary.skippedInaccessible, 'item(s) were inaccessible and skipped.');
  note(summary.symlinksNotFollowed, 'symlink(s) were not followed (security).');
  note(
    summary.linesSkippedDueToRegexTimeout,
    'line(s) skipped (regex timeout).'
  );
  return lines.join('\n');
}

export function buildStructuredResult(
  result: SearchContentResult
): SearchContentStructuredResult {
  return {
    ok: true,
    basePath: result.basePath,
    pattern: result.pattern,
    filePattern: result.filePattern,
    matches: result.matches.map((m) => ({
      file: pathModule.relative(result.basePath, m.file),
      line: m.line,
      content: m.content,
      contextBefore: m.contextBefore,
      contextAfter: m.contextAfter,
      matchCount: m.matchCount,
    })),
    summary: {
      filesScanned: result.summary.filesScanned,
      filesMatched: result.summary.filesMatched,
      totalMatches: result.summary.matches,
      truncated: result.summary.truncated,
      skippedTooLarge: result.summary.skippedTooLarge || undefined,
      skippedBinary: result.summary.skippedBinary || undefined,
      skippedInaccessible: result.summary.skippedInaccessible || undefined,
      linesSkippedDueToRegexTimeout:
        result.summary.linesSkippedDueToRegexTimeout || undefined,
      stoppedReason: result.summary.stoppedReason,
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
  const { truncatedReason, tip } = buildTruncationInfo(result);
  let textOutput = formatContentMatches(result.matches);
  textOutput += formatOperationSummary({
    truncated: result.summary.truncated,
    truncatedReason,
    tip,
    skippedTooLarge: result.summary.skippedTooLarge,
    skippedBinary: result.summary.skippedBinary,
    skippedInaccessible: result.summary.skippedInaccessible,
    linesSkippedDueToRegexTimeout: result.summary.linesSkippedDueToRegexTimeout,
  });

  if (result.summary.truncated && !tip) {
    textOutput += `\nScanned ${result.summary.filesScanned} files, found ${result.summary.matches} matches in ${result.summary.filesMatched} files.`;
  }

  return textOutput;
}
