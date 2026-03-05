import * as path from 'node:path';
import type { Stats } from 'node:fs';

import type { SearchFilesResult, SearchResult } from '../../config.js';
import {
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from '../constants.js';
import { withTimedAbortSignal } from '../fs-helpers.js';
import { isSensitivePath } from '../paths.js';
import {
  isPathWithinDirectories,
  normalizePath,
  validateExistingDirectory,
  validateExistingPathDetailed,
} from '../paths.js';
import { reportPeriodicProgress } from '../utils.js';
import {
  compareOptionalNumberDesc,
  compareStringValues,
  isEntryAccessibleByType,
  needsStatsForSort,
  resolveEntryType,
  resolveStopReason,
  stableSortByDerivedString,
  withOptionalStoppedReason,
} from './common.js';
import type { DirentLike, EntryType } from './common.js';
import { isIgnoredByGitignore, loadRootGitignore } from './gitignore.js';
import { globEntries } from './glob-engine.js';
import { buildGlobOptions } from './glob-engine.js';

// Internal default for find tool - not exposed to MCP users
const INTERNAL_MAX_RESULTS = 1000;

type SortBy = 'name' | 'size' | 'modified' | 'path';

interface SearchFilesOptions {
  maxResults?: number;
  sortBy?: SortBy;
  maxDepth?: number;
  maxFilesScanned?: number;
  timeoutMs?: number;
  baseNameMatch?: boolean;
  skipSymlinks?: boolean;
  includeHidden?: boolean;
  respectGitignore?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: { total?: number; current: number }) => void;
}

type NormalizedOptions = Required<
  Omit<SearchFilesOptions, 'maxDepth' | 'sortBy' | 'signal' | 'onProgress'>
> & {
  maxDepth?: number;
  sortBy: NonNullable<SearchFilesOptions['sortBy']>;
};

type StopReason = SearchFilesResult['summary']['stoppedReason'];

function normalizeOptions(options: SearchFilesOptions): NormalizedOptions {
  const normalized: NormalizedOptions = {
    maxResults: options.maxResults ?? INTERNAL_MAX_RESULTS,
    sortBy: options.sortBy ?? 'path',
    maxFilesScanned: options.maxFilesScanned ?? DEFAULT_SEARCH_MAX_FILES,
    timeoutMs: options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    baseNameMatch: options.baseNameMatch ?? false,
    skipSymlinks: options.skipSymlinks ?? true,
    includeHidden: options.includeHidden ?? false,
    respectGitignore: options.respectGitignore ?? false,
  };
  if (options.maxDepth !== undefined) {
    normalized.maxDepth = options.maxDepth;
  }
  return normalized;
}

interface SearchEntry {
  path: string;
  relativePath?: string;
  dirent: DirentLike;
  stats?: Stats;
}

interface CollectState {
  results: SearchResult[];
  filesScanned: number;
  truncated: boolean;
  stoppedReason?: StopReason;
  skippedInaccessible: number;
}

interface CollectOutcome {
  results: SearchResult[];
  filesScanned: number;
  truncated: boolean;
  stoppedReason?: StopReason;
  skippedInaccessible: number;
}

function buildSearchResult(
  entry: { path: string; stats?: Stats },
  entryType: EntryType,
  needsStats: boolean
): SearchResult {
  let resolvedType: SearchResult['type'] = 'other';
  if (entryType === 'directory') {
    resolvedType = 'directory';
  } else if (entryType === 'file') {
    resolvedType = 'file';
  }
  const size =
    needsStats && entry.stats?.isFile() ? entry.stats.size : undefined;
  const modified = needsStats ? entry.stats?.mtime : undefined;
  return {
    path: entry.path,
    type: resolvedType,
    ...(size !== undefined ? { size } : {}),
    ...(modified !== undefined ? { modified } : {}),
  };
}

function shouldStopCollecting(
  state: CollectState,
  normalized: NormalizedOptions,
  signal: AbortSignal
): boolean {
  const stopReason = resolveStopReason<Exclude<StopReason, undefined>>({
    signal,
    current: state.filesScanned,
    max: normalized.maxFilesScanned,
    abortedReason: 'timeout',
    maxReason: 'maxFiles',
  });
  if (stopReason !== undefined) {
    state.truncated = true;
    state.stoppedReason = stopReason;
    return true;
  }
  return false;
}

function shouldIncludeEntry(
  entryType: EntryType,
  normalized: NormalizedOptions
): boolean {
  return !normalized.skipSymlinks || entryType !== 'symlink';
}

function createCollectState(): CollectState {
  return {
    results: [],
    filesScanned: 0,
    truncated: false,
    skippedInaccessible: 0,
  };
}

function buildSearchStream(
  root: string,
  pattern: string,
  excludePatterns: readonly string[],
  normalized: NormalizedOptions,
  needsStats: boolean
): AsyncIterable<SearchEntry> {
  const options = buildGlobOptions({
    cwd: root,
    pattern,
    excludePatterns,
    includeHidden: normalized.includeHidden,
    baseNameMatch: normalized.baseNameMatch,
    caseSensitiveMatch: true,
    followSymbolicLinks: false,
    onlyFiles: true,
    stats: needsStats,
    ...(normalized.maxDepth !== undefined
      ? { maxDepth: normalized.maxDepth }
      : {}),
  });
  return globEntries(options);
}

function buildCollectResult(state: CollectState): CollectOutcome {
  const outcome: CollectOutcome = {
    results: state.results,
    filesScanned: state.filesScanned,
    truncated: state.truncated,
    skippedInaccessible: state.skippedInaccessible,
  };

  if (state.stoppedReason !== undefined) {
    outcome.stoppedReason = state.stoppedReason;
  }

  return outcome;
}

function handleEntry(
  entry: SearchEntry,
  entryType: EntryType,
  needsStats: boolean,
  normalized: NormalizedOptions,
  state: CollectState
): void {
  state.results.push(buildSearchResult(entry, entryType, needsStats));
  if (state.results.length >= normalized.maxResults) {
    state.truncated = true;
    state.stoppedReason = 'maxResults';
  }
}

async function collectFromStream(
  stream: AsyncIterable<SearchEntry>,
  root: string,
  rootDirectories: readonly string[],
  gitignoreMatcher: Awaited<ReturnType<typeof loadRootGitignore>>,
  normalized: NormalizedOptions,
  needsStats: boolean,
  state: CollectState,
  signal: AbortSignal,
  accessDeps: Parameters<typeof isEntryAccessibleByType>[4],
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<void> {
  for await (const entry of stream) {
    if (shouldStopCollecting(state, normalized, signal)) break;
    state.filesScanned++;
    reportPeriodicProgress(onProgress, state.filesScanned, {
      total: normalized.maxFilesScanned,
      throttleModulo: 25,
    });

    if (
      isEntryIgnoredByGitignore(
        gitignoreMatcher,
        root,
        entry.path,
        entry.relativePath
      )
    ) {
      continue;
    }

    const entryType = resolveEntryType(entry.dirent);

    if (!shouldIncludeEntry(entryType, normalized)) {
      continue;
    }

    const isAccessible = await isEntryAccessibleByType(
      entry.path,
      entryType,
      rootDirectories,
      signal,
      accessDeps
    );
    if (!isAccessible) {
      state.skippedInaccessible++;
      continue;
    }

    handleEntry(entry, entryType, needsStats, normalized, state);
    if (state.truncated) break;
  }

  reportPeriodicProgress(onProgress, state.filesScanned, {
    total: normalized.maxFilesScanned,
    throttleModulo: 25,
    force: true,
  });
}

function isEntryIgnoredByGitignore(
  matcher: Awaited<ReturnType<typeof loadRootGitignore>>,
  root: string,
  entryPath: string,
  relativePath?: string
): boolean {
  if (!matcher) return false;
  return isIgnoredByGitignore(
    matcher,
    root,
    entryPath,
    relativePath ? { relativePath } : {}
  );
}

async function collectSearchResults(
  root: string,
  pattern: string,
  excludePatterns: readonly string[],
  normalized: NormalizedOptions,
  signal: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<CollectOutcome> {
  const needsStats = needsStatsForSort(normalized.sortBy);
  const stream = buildSearchStream(
    root,
    pattern,
    excludePatterns,
    normalized,
    needsStats
  );
  const state = createCollectState();
  const rootDirectories = [root];
  const accessDeps = {
    normalizePath,
    isPathWithinDirectories,
    isSensitivePath,
    validateSymlinkPath: validateExistingPathDetailed,
  };

  const gitignoreMatcher = normalized.respectGitignore
    ? await loadRootGitignore(root, signal)
    : null;

  await collectFromStream(
    stream,
    root,
    rootDirectories,
    gitignoreMatcher,
    normalized,
    needsStats,
    state,
    signal,
    accessDeps,
    onProgress
  );
  return buildCollectResult(state);
}

function buildSearchSummary(
  results: SearchResult[],
  filesScanned: number,
  truncated: boolean,
  stoppedReason: StopReason | undefined,
  skippedInaccessible: number
): SearchFilesResult['summary'] {
  const summary = {
    matched: results.length,
    truncated,
    skippedInaccessible,
    filesScanned,
  };
  return withOptionalStoppedReason(summary, stoppedReason);
}

interface Sortable {
  name?: string;
  size?: number;
  modified?: Date;
  path?: string;
}

function compareNameThenPath(a: Sortable, b: Sortable): number {
  const nameCompare = compareStringValues(a.name, b.name);
  if (nameCompare !== 0) return nameCompare;
  return compareStringValues(a.path, b.path);
}

function comparePathThenName(a: Sortable, b: Sortable): number {
  const pathCompare = compareStringValues(a.path, b.path);
  if (pathCompare !== 0) return pathCompare;
  return compareStringValues(a.name, b.name);
}

const SORT_COMPARATORS: Readonly<
  Record<SortBy, (a: Sortable, b: Sortable) => number>
> = {
  size: (a, b) =>
    compareOptionalNumberDesc(a.size, b.size, () => compareNameThenPath(a, b)),
  modified: (a, b) =>
    compareOptionalNumberDesc(
      a.modified?.getTime(),
      b.modified?.getTime(),
      () => compareNameThenPath(a, b)
    ),
  path: (a, b) => comparePathThenName(a, b),
  name: (a, b) => compareNameThenPath(a, b),
};

export function sortSearchResults(results: Sortable[], sortBy: SortBy): void {
  if (sortBy === 'name') {
    stableSortByDerivedString(
      results,
      (item) => path.basename(item.path ?? ''),
      (left, right) => comparePathThenName(left, right)
    );
    return;
  }

  const comparator = SORT_COMPARATORS[sortBy];
  results.sort(comparator);
}

async function runSearchFiles(
  root: string,
  pattern: string,
  excludePatterns: readonly string[],
  normalized: NormalizedOptions,
  signal: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<{ results: SearchResult[]; summary: SearchFilesResult['summary'] }> {
  const {
    results,
    filesScanned,
    truncated,
    stoppedReason,
    skippedInaccessible,
  } = await collectSearchResults(
    root,
    pattern,
    excludePatterns,
    normalized,
    signal,
    onProgress
  );

  sortSearchResults(results, normalized.sortBy);

  return {
    results,
    summary: buildSearchSummary(
      results,
      filesScanned,
      truncated,
      stoppedReason,
      skippedInaccessible
    ),
  };
}

export async function searchFiles(
  basePath: string,
  pattern: string,
  excludePatterns: readonly string[] = [],
  options: SearchFilesOptions = {}
): Promise<SearchFilesResult> {
  const normalized = normalizeOptions(options);
  return withTimedAbortSignal(
    options.signal,
    normalized.timeoutMs,
    async (signal) => {
      const root = await validateExistingDirectory(basePath, signal);
      const { results, summary } = await runSearchFiles(
        root,
        pattern,
        excludePatterns,
        normalized,
        signal,
        options.onProgress
      );

      return {
        basePath: root,
        pattern,
        results,
        summary,
      };
    }
  );
}
