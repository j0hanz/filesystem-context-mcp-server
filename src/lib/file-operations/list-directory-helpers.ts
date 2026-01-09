import type {
  DirectoryEntry,
  ListDirectoryResult,
} from '../../config/types.js';
import {
  DEFAULT_LIST_MAX_ENTRIES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from '../constants.js';
import { globEntries } from './glob-engine.js';
import {
  appendEntry,
  type EntryCandidate,
  type EntryTotals,
} from './list-directory-entry.js';

export interface ListDirectoryOptions {
  includeHidden?: boolean;
  excludePatterns?: readonly string[];
  maxDepth?: number;
  maxEntries?: number;
  sortBy?: 'name' | 'size' | 'modified' | 'type';
  includeSymlinkTargets?: boolean;
  pattern?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type NormalizedOptions = Required<
  Omit<ListDirectoryOptions, 'signal' | 'pattern'>
> & {
  pattern?: string;
};

function normalizePattern(pattern: string | undefined): string | undefined {
  if (!pattern || pattern.length === 0) return undefined;
  return pattern;
}

export function normalizeOptions(
  options: ListDirectoryOptions
): NormalizedOptions {
  const pattern = normalizePattern(options.pattern);
  const normalized: NormalizedOptions = {
    includeHidden: options.includeHidden ?? false,
    excludePatterns: options.excludePatterns ?? [],
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntries: options.maxEntries ?? DEFAULT_LIST_MAX_ENTRIES,
    sortBy: options.sortBy ?? 'name',
    includeSymlinkTargets: options.includeSymlinkTargets ?? false,
    timeoutMs: options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
  };
  if (pattern !== undefined) {
    normalized.pattern = pattern;
  }
  return normalized;
}

function sortEntries(
  entries: DirectoryEntry[],
  sortBy: NonNullable<ListDirectoryOptions['sortBy']>
): void {
  const compare = {
    name: (a: DirectoryEntry, b: DirectoryEntry) =>
      a.name.localeCompare(b.name),
    type: (a: DirectoryEntry, b: DirectoryEntry) =>
      a.type.localeCompare(b.type),
    size: (a: DirectoryEntry, b: DirectoryEntry) =>
      (a.size ?? 0) - (b.size ?? 0),
    modified: (a: DirectoryEntry, b: DirectoryEntry) =>
      (a.modified?.getTime() ?? 0) - (b.modified?.getTime() ?? 0),
  }[sortBy];
  entries.sort(compare);
}

function needsStatsForSort(sortBy: NormalizedOptions['sortBy']): boolean {
  return sortBy === 'size' || sortBy === 'modified';
}

function resolveMaxDepth(normalized: NormalizedOptions): number {
  if (!normalized.pattern) {
    return 1; // Always shallow listing unless a pattern is provided
  }
  return normalized.maxDepth;
}

function shouldStopScan(
  signal: AbortSignal,
  entryCount: number,
  maxEntries: number
): { stop: boolean; reason?: ListDirectoryResult['summary']['stoppedReason'] } {
  if (signal.aborted) {
    return { stop: true, reason: 'aborted' };
  }
  if (entryCount >= maxEntries) {
    return { stop: true, reason: 'maxEntries' };
  }
  return { stop: false };
}

function createEntryStream(
  basePath: string,
  normalized: NormalizedOptions,
  maxDepth: number,
  needsStats: boolean
): AsyncIterable<EntryCandidate> {
  return globEntries({
    cwd: basePath,
    pattern: normalized.pattern ?? '*',
    excludePatterns: normalized.excludePatterns,
    includeHidden: normalized.includeHidden,
    baseNameMatch: false,
    caseSensitiveMatch: true,
    maxDepth,
    followSymbolicLinks: false,
    onlyFiles: false,
    stats: needsStats,
  });
}

function buildSummary(
  entries: DirectoryEntry[],
  totals: EntryTotals,
  maxDepth: number,
  truncated: boolean,
  stoppedReason: ListDirectoryResult['summary']['stoppedReason'] | undefined
): ListDirectoryResult['summary'] {
  const baseSummary: ListDirectoryResult['summary'] = {
    totalEntries: entries.length,
    entriesScanned: entries.length,
    entriesVisible: entries.length,
    totalFiles: totals.files,
    totalDirectories: totals.directories,
    maxDepthReached: maxDepth,
    truncated,
    skippedInaccessible: 0,
    symlinksNotFollowed: 0,
  };
  return {
    ...baseSummary,
    ...(stoppedReason !== undefined ? { stoppedReason } : {}),
  };
}

async function collectEntries(
  basePath: string,
  normalized: NormalizedOptions,
  signal: AbortSignal,
  needsStats: boolean,
  maxDepth: number
): Promise<{
  entries: DirectoryEntry[];
  totals: EntryTotals;
  truncated: boolean;
  stoppedReason: ListDirectoryResult['summary']['stoppedReason'] | undefined;
}> {
  const entries: DirectoryEntry[] = [];
  const totals: EntryTotals = { files: 0, directories: 0 };
  let truncated = false;
  let stoppedReason:
    | ListDirectoryResult['summary']['stoppedReason']
    | undefined;

  const stream = createEntryStream(basePath, normalized, maxDepth, needsStats);

  for await (const entry of stream) {
    const stop = shouldStopScan(signal, entries.length, normalized.maxEntries);
    if (stop.stop) {
      truncated = true;
      stoppedReason = stop.reason;
      break;
    }

    await appendEntry(basePath, entry, normalized, needsStats, totals, entries);
  }

  return { entries, totals, truncated, stoppedReason };
}

export async function executeListDirectory(
  basePath: string,
  normalized: NormalizedOptions,
  signal: AbortSignal
): Promise<{
  entries: DirectoryEntry[];
  summary: ListDirectoryResult['summary'];
}> {
  const needsStats = needsStatsForSort(normalized.sortBy);
  const maxDepth = resolveMaxDepth(normalized);
  const { entries, totals, truncated, stoppedReason } = await collectEntries(
    basePath,
    normalized,
    signal,
    needsStats,
    maxDepth
  );

  sortEntries(entries, normalized.sortBy);

  return {
    entries,
    summary: buildSummary(entries, totals, maxDepth, truncated, stoppedReason),
  };
}
