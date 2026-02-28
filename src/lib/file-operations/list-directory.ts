import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Stats } from 'node:fs';

import type { DirectoryEntry, ListDirectoryResult } from '../../config.js';
import {
  DEFAULT_LIST_MAX_ENTRIES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_SEARCH_TIMEOUT_MS,
  PARALLEL_CONCURRENCY,
} from '../constants.js';
import {
  createTimedAbortSignal,
  isHidden,
  processInParallel,
  withAbort,
} from '../fs-helpers.js';
import { isSensitivePath } from '../path-policy.js';
import {
  isPathWithinDirectories,
  normalizePath,
  validateExistingDirectory,
  validateExistingPathDetailed,
} from '../path-validation.js';
import {
  needsStatsForSort,
  resolveEntryType,
  withOptionalStoppedReason,
} from './common.js';
import type { DirentLike, EntryType } from './common.js';
import { globEntries } from './glob-engine.js';

interface ListDirectoryOptions {
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

type NormalizedOptions = Required<
  Omit<ListDirectoryOptions, 'signal' | 'pattern'>
> & {
  pattern?: string;
};

type StoppedReason = ListDirectoryResult['summary']['stoppedReason'];

interface EntryTotals {
  files: number;
  directories: number;
}

interface Counters {
  skippedInaccessible: number;
  symlinksNotFollowed: number;
}

interface EntryCandidate {
  path: string;
  dirent: DirentLike;
  stats?: Stats;
}

interface AppendContext {
  basePath: string;
  needsStats: boolean;
  includeSymlinkTargets: boolean;
  totals: EntryTotals;
  entries: DirectoryEntry[];
}

function normalizePattern(pattern: string | undefined): string | undefined {
  if (!pattern || pattern.length === 0) return undefined;
  return pattern;
}

function normalizeOptions(options: ListDirectoryOptions): NormalizedOptions {
  const pattern = normalizePattern(options.pattern);
  const normalized: NormalizedOptions = {
    includeHidden: options.includeHidden ?? false,
    excludePatterns: options.excludePatterns ?? [],
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntries: options.maxEntries ?? DEFAULT_LIST_MAX_ENTRIES,
    sortBy: options.sortBy ?? 'name',
    includeSymlinkTargets: options.includeSymlinkTargets ?? false,
    timeoutMs: options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    ...(pattern !== undefined ? { pattern } : {}),
  };

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

function resolveMaxDepth(normalized: NormalizedOptions): number {
  if (!normalized.pattern) {
    return 1;
  }
  return normalized.maxDepth;
}

function getStopReason(
  signal: AbortSignal,
  acceptedCount: number,
  maxEntries: number
): StoppedReason | undefined {
  if (signal.aborted) return 'aborted';
  if (acceptedCount >= maxEntries) return 'maxEntries';
  return undefined;
}

async function* readDirectoryEntries(
  basePath: string,
  normalized: NormalizedOptions,
  needsStats: boolean,
  signal: AbortSignal
): AsyncGenerator<EntryCandidate> {
  const dirents = await withAbort(
    fsp.readdir(basePath, { withFileTypes: true }),
    signal
  );

  const entries: { dirent: (typeof dirents)[number]; entryPath: string }[] = [];
  for (const dirent of dirents) {
    if (!normalized.includeHidden && isHidden(dirent.name)) {
      continue;
    }
    entries.push({ dirent, entryPath: path.join(basePath, dirent.name) });
  }

  if (!needsStats) {
    for (const entry of entries) {
      yield {
        path: entry.entryPath,
        dirent: entry.dirent,
      };
    }
    return;
  }

  const { results, errors } = await processInParallel(
    entries.map((_, index) => index),
    async (index) => {
      const candidate = entries[index];
      if (!candidate) {
        throw new Error(`Entry index out of range: ${String(index)}`);
      }
      return {
        index,
        stats: await withAbort(fsp.lstat(candidate.entryPath), signal),
      };
    },
    PARALLEL_CONCURRENCY,
    signal
  );

  if (errors.length > 0) {
    throw errors[0]?.error ?? new Error('Failed to read entry stats');
  }

  const statsByIndex: (Stats | undefined)[] = [];
  for (const result of results) {
    statsByIndex[result.index] = result.stats;
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const stats = statsByIndex[index];
    yield {
      path: entry.entryPath,
      dirent: entry.dirent,
      ...(stats ? { stats } : {}),
    };
  }
}

function createEntryStream(
  basePath: string,
  normalized: NormalizedOptions,
  maxDepth: number,
  needsStats: boolean,
  signal: AbortSignal
): AsyncIterable<EntryCandidate> {
  if (shouldUseFastPath(normalized, maxDepth)) {
    return readDirectoryEntries(basePath, normalized, needsStats, signal);
  }

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

function shouldUseFastPath(
  normalized: NormalizedOptions,
  maxDepth: number
): boolean {
  return (
    !normalized.pattern &&
    normalized.excludePatterns.length === 0 &&
    maxDepth === 1
  );
}

function resolveRelativePath(basePath: string, entryPath: string): string {
  return path.relative(basePath, entryPath) || path.basename(entryPath);
}

async function resolveSymlinkTarget(
  entryType: EntryType,
  includeSymlinkTargets: boolean,
  entryPath: string
): Promise<string | undefined> {
  if (entryType !== 'symlink' || !includeSymlinkTargets) {
    return undefined;
  }
  return fsp.readlink(entryPath).catch(() => undefined);
}

function updateTotals(entryType: EntryType, totals: EntryTotals): void {
  if (entryType === 'file') totals.files += 1;
  if (entryType === 'directory') totals.directories += 1;
}

function buildDirectoryEntry(
  basePath: string,
  entry: { path: string; stats?: Stats },
  entryType: EntryType,
  needsStats: boolean,
  symlinkTarget: string | undefined
): DirectoryEntry {
  const size =
    needsStats && entry.stats?.isFile() ? entry.stats.size : undefined;
  const modified = needsStats ? entry.stats?.mtime : undefined;

  return {
    name: path.basename(entry.path),
    path: entry.path,
    relativePath: resolveRelativePath(basePath, entry.path),
    type: entryType,
    ...(size !== undefined ? { size } : {}),
    ...(modified !== undefined ? { modified } : {}),
    ...(symlinkTarget !== undefined ? { symlinkTarget } : {}),
  };
}

function trackSymlink(
  entryType: EntryType,
  includeSymlinkTargets: boolean,
  counters: Counters
): void {
  if (entryType === 'symlink' && !includeSymlinkTargets) {
    counters.symlinksNotFollowed += 1;
  }
}

async function isEntryAccessible(
  entryPath: string,
  entryType: EntryType,
  basePathDirectories: readonly string[],
  signal: AbortSignal,
  counters: Counters
): Promise<boolean> {
  if (entryType !== 'symlink') {
    const normalized = normalizePath(entryPath);
    if (!isPathWithinDirectories(normalized, basePathDirectories)) {
      counters.skippedInaccessible += 1;
      return false;
    }
    if (isSensitivePath(entryPath, normalized)) {
      counters.skippedInaccessible += 1;
      return false;
    }
    return true;
  }

  try {
    const validated = await validateExistingPathDetailed(entryPath, signal);
    if (isSensitivePath(validated.requestedPath, validated.resolvedPath)) {
      counters.skippedInaccessible += 1;
      return false;
    }
    return true;
  } catch {
    counters.skippedInaccessible += 1;
    return false;
  }
}

function appendEntry(
  entry: EntryCandidate,
  entryType: EntryType,
  symlinkTarget: string | undefined,
  ctx: AppendContext
): void {
  updateTotals(entryType, ctx.totals);

  ctx.entries.push(
    buildDirectoryEntry(
      ctx.basePath,
      entry,
      entryType,
      ctx.needsStats,
      symlinkTarget
    )
  );
}

async function enqueueAppendEntry(
  entry: EntryCandidate,
  entryType: EntryType,
  ctx: AppendContext,
  pending: Promise<void>[],
  flushPending: () => Promise<void>
): Promise<void> {
  if (!ctx.includeSymlinkTargets) {
    appendEntry(entry, entryType, undefined, ctx);
    return;
  }

  // Preserve the original behavior: resolve symlink targets in parallel
  // when includeSymlinkTargets is enabled (bounded by PARALLEL_CONCURRENCY).
  const task = (async (): Promise<void> => {
    const symlinkTarget = await resolveSymlinkTarget(
      entryType,
      ctx.includeSymlinkTargets,
      entry.path
    );
    appendEntry(entry, entryType, symlinkTarget, ctx);
  })();

  pending.push(task);

  if (pending.length >= PARALLEL_CONCURRENCY) {
    await flushPending();
  }
}

function buildSummary(
  entries: DirectoryEntry[],
  totals: EntryTotals,
  maxDepth: number,
  truncated: boolean,
  stoppedReason: StoppedReason | undefined,
  counters: Counters
): ListDirectoryResult['summary'] {
  const summary = {
    totalEntries: entries.length,
    entriesScanned: entries.length,
    entriesVisible: entries.length,
    totalFiles: totals.files,
    totalDirectories: totals.directories,
    maxDepthReached: maxDepth,
    truncated,
    skippedInaccessible: counters.skippedInaccessible,
    symlinksNotFollowed: counters.symlinksNotFollowed,
  };

  return withOptionalStoppedReason(summary, stoppedReason);
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
  stoppedReason: StoppedReason | undefined;
  counters: Counters;
}> {
  const entries: DirectoryEntry[] = [];
  const totals: EntryTotals = { files: 0, directories: 0 };
  const counters: Counters = { skippedInaccessible: 0, symlinksNotFollowed: 0 };
  const basePathDirectories = [basePath];

  let truncated = false;
  let stoppedReason: StoppedReason | undefined;

  const pending: Promise<void>[] = [];
  let acceptedCount = 0;

  const stream = createEntryStream(
    basePath,
    normalized,
    maxDepth,
    needsStats,
    signal
  );

  const flushPending = async (): Promise<void> => {
    if (pending.length === 0) return;
    await Promise.allSettled(pending.splice(0));
  };

  const appendCtx: AppendContext = {
    basePath,
    needsStats,
    includeSymlinkTargets: normalized.includeSymlinkTargets,
    totals,
    entries,
  };

  for await (const entry of stream) {
    const stopReason = getStopReason(
      signal,
      acceptedCount,
      normalized.maxEntries
    );
    if (stopReason) {
      truncated = true;
      stoppedReason = stopReason;
      break;
    }

    const entryType = resolveEntryType(entry.dirent);
    trackSymlink(entryType, normalized.includeSymlinkTargets, counters);

    const accessible = await isEntryAccessible(
      entry.path,
      entryType,
      basePathDirectories,
      signal,
      counters
    );
    if (!accessible) {
      continue;
    }

    acceptedCount += 1;
    await enqueueAppendEntry(
      entry,
      entryType,
      appendCtx,
      pending,
      flushPending
    );
  }

  if (normalized.includeSymlinkTargets) {
    await flushPending();
  }

  return { entries, totals, truncated, stoppedReason, counters };
}

async function executeListDirectory(
  basePath: string,
  normalized: NormalizedOptions,
  signal: AbortSignal
): Promise<{
  entries: DirectoryEntry[];
  summary: ListDirectoryResult['summary'];
}> {
  const needsStats = needsStatsForSort(normalized.sortBy);
  const maxDepth = resolveMaxDepth(normalized);

  const { entries, totals, truncated, stoppedReason, counters } =
    await collectEntries(basePath, normalized, signal, needsStats, maxDepth);

  sortEntries(entries, normalized.sortBy);

  return {
    entries,
    summary: buildSummary(
      entries,
      totals,
      maxDepth,
      truncated,
      stoppedReason,
      counters
    ),
  };
}

export async function listDirectory(
  dirPath: string,
  options: ListDirectoryOptions = {}
): Promise<ListDirectoryResult> {
  const normalized = normalizeOptions(options);
  const { signal, cleanup } = createTimedAbortSignal(
    options.signal,
    normalized.timeoutMs
  );
  const basePath = await validateExistingDirectory(dirPath, signal);

  try {
    const { entries, summary } = await executeListDirectory(
      basePath,
      normalized,
      signal
    );
    return { path: basePath, entries, summary };
  } finally {
    cleanup();
  }
}
