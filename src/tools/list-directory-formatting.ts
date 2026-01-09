import { formatOperationSummary, joinLines } from '../config/formatting.js';
import type { listDirectory } from '../lib/file-operations/list-directory.js';

type ListEntries = Awaited<ReturnType<typeof listDirectory>>['entries'];
type ListSummary = Awaited<ReturnType<typeof listDirectory>>['summary'];
type ListResult = Awaited<ReturnType<typeof listDirectory>>;

function formatDirectoryEntry(entry: ListEntries[number]): string {
  const suffix = entry.type === 'directory' ? '/' : '';
  return `  ${entry.relativePath}${suffix}`;
}

function formatDirectoryListing(
  entries: ListEntries,
  basePath: string,
  summary: ListSummary
): string {
  if (entries.length === 0) {
    if (!summary.entriesScanned || summary.entriesScanned === 0) {
      return `${basePath} (empty)`;
    }
    return `${basePath} (no matches)`;
  }

  return joinLines([basePath, ...entries.map(formatDirectoryEntry)]);
}

function getTruncatedReason(summary: ListSummary): string | undefined {
  if (!summary.truncated) return undefined;
  if (summary.stoppedReason === 'maxEntries') {
    return `max entries (${summary.totalEntries})`;
  }
  return 'aborted';
}

export function buildTextResult(result: ListResult): string {
  const { entries, summary, path } = result;
  const truncatedReason = getTruncatedReason(summary);
  const summaryOptions: Parameters<typeof formatOperationSummary>[0] = {
    truncated: summary.truncated,
  };
  if (truncatedReason !== undefined) {
    summaryOptions.truncatedReason = truncatedReason;
  }
  return (
    formatDirectoryListing(entries, path, summary) +
    formatOperationSummary(summaryOptions)
  );
}
