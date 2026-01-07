import {
  formatBytes,
  formatOperationSummary,
  joinLines,
} from '../config/formatting.js';
import type { listDirectory } from '../lib/file-operations/list-directory.js';

type ListEntries = Awaited<ReturnType<typeof listDirectory>>['entries'];
type ListSummary = Awaited<ReturnType<typeof listDirectory>>['summary'];

type ListResult = Awaited<ReturnType<typeof listDirectory>>;

function countDirectories(entries: ListEntries): number {
  return entries.reduce(
    (count, entry) => count + (entry.type === 'directory' ? 1 : 0),
    0
  );
}

function formatDirectoryEntry(entry: ListEntries[number]): string {
  const isDir = entry.type === 'directory';
  let tag = '[FILE]';
  if (isDir) {
    tag = '[DIR]';
  } else if (entry.type === 'symlink') {
    tag = '[LINK]';
  }
  const size = entry.size !== undefined ? ` (${formatBytes(entry.size)})` : '';
  const symlink = entry.symlinkTarget ? ` -> ${entry.symlinkTarget}` : '';
  return `${tag} ${entry.relativePath}${isDir ? '' : size}${symlink}`;
}

function formatEmptyDirectoryListing(summary: ListSummary): string {
  if (!summary.entriesScanned || summary.entriesScanned === 0) {
    return 'Empty directory';
  }
  if (summary.entriesVisible === 0) {
    return 'No entries matched visibility filters (hidden/excludePatterns).';
  }
  return 'No entries matched the provided pattern.';
}

function formatDirectoryListing(
  entries: ListEntries,
  basePath: string,
  summary: ListSummary
): string {
  if (entries.length === 0) {
    return formatEmptyDirectoryListing(summary);
  }

  const dirs = countDirectories(entries);
  const entryLines = entries.map(formatDirectoryEntry);
  const files = entries.length - dirs;
  return joinLines([
    `${basePath} (${dirs} dirs, ${files} files):`,
    ...entryLines,
  ]);
}

function resolveTruncatedReason(summary: ListSummary): string | undefined {
  if (summary.stoppedReason === 'aborted') {
    return 'operation aborted';
  }
  if (summary.stoppedReason === 'maxEntries') {
    return `reached max entries limit (${summary.totalEntries} returned)`;
  }
  return undefined;
}

function resolveTruncatedTip(summary: ListSummary): string | undefined {
  return summary.stoppedReason === 'maxEntries'
    ? 'Increase maxEntries or reduce maxDepth to see more results.'
    : undefined;
}

export function buildTextResult(result: ListResult): string {
  const { entries, summary, path } = result;
  let textOutput = formatDirectoryListing(entries, path, summary);
  textOutput += formatOperationSummary({
    truncated: summary.truncated,
    truncatedReason: resolveTruncatedReason(summary),
    tip: resolveTruncatedTip(summary),
    skippedInaccessible: summary.skippedInaccessible,
    symlinksNotFollowed: summary.symlinksNotFollowed,
  });
  return textOutput;
}
