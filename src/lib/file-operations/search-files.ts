import * as path from 'node:path';
import type { Stats } from 'node:fs';

import type { SearchFilesResult, SearchResult } from '../../config.js';
import {
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from '../constants.js';
import { createTimedAbortSignal } from '../fs-helpers.js';
import { isSensitivePath } from '../path-policy.js';
import {
  isPathWithinDirectories,
  normalizePath,
  validateExistingDirectory,
  validateExistingPathDetailed,
} from '../path-validation.js';
import { needsStatsForSort, withOptionalStoppedReason } from './common.js';
import { isIgnoredByGitignore, loadRootGitignore } from './gitignore.js';
import { globEntries, resolveEntryType } from './glob-engine.js';

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

type SearchEntryType = 'directory' | 'symlink' | 'file' | 'other';

interface SearchEntry {
  path: string;
  relativePath?: string;
  dirent: {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isFile(): boolean;
  };
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
  entryType: SearchEntryType,
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

function markStopped(state: CollectState, reason: StopReason): void {
  state.truncated = true;
  state.stoppedReason = reason;
}

function shouldStopCollecting(
  state: CollectState,
  normalized: NormalizedOptions,
  signal: AbortSignal
): boolean {
  if (signal.aborted) {
    markStopped(state, 'timeout');
    return true;
  }
  if (state.filesScanned >= normalized.maxFilesScanned) {
    markStopped(state, 'maxFiles');
    return true;
  }
  return false;
}

function shouldIncludeEntry(
  entryType: SearchEntryType,
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
  const options: Parameters<typeof globEntries>[0] = {
    cwd: root,
    pattern,
    excludePatterns,
    includeHidden: normalized.includeHidden,
    baseNameMatch: normalized.baseNameMatch,
    caseSensitiveMatch: true,
    followSymbolicLinks: false,
    onlyFiles: true,
    stats: needsStats,
  };
  if (normalized.maxDepth !== undefined) {
    options.maxDepth = normalized.maxDepth;
  }
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
  entryType: SearchEntryType,
  needsStats: boolean,
  normalized: NormalizedOptions,
  state: CollectState
): void {
  state.results.push(buildSearchResult(entry, entryType, needsStats));
  if (state.results.length >= normalized.maxResults) {
    markStopped(state, 'maxResults');
  }
}

function reportSearchFilesProgress(
  onProgress: SearchFilesOptions['onProgress'],
  current: number,
  total: number,
  force = false
): void {
  if (!onProgress || current === 0) return;
  if (!force && current % 25 !== 0) return;
  onProgress({ current, total });
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
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<void> {
  for await (const entry of stream) {
    if (shouldStopCollecting(state, normalized, signal)) break;
    state.filesScanned++;
    reportSearchFilesProgress(
      onProgress,
      state.filesScanned,
      normalized.maxFilesScanned
    );

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

    const isAccessible = await isEntryAccessible(
      entry,
      entryType,
      rootDirectories,
      signal
    );
    if (!isAccessible) {
      state.skippedInaccessible++;
      continue;
    }

    handleEntry(entry, entryType, needsStats, normalized, state);
    if (state.truncated) break;
  }

  reportSearchFilesProgress(
    onProgress,
    state.filesScanned,
    normalized.maxFilesScanned,
    true
  );
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

async function isEntryAccessible(
  entry: SearchEntry,
  entryType: SearchEntryType,
  rootDirectories: readonly string[],
  signal: AbortSignal
): Promise<boolean> {
  if (entryType === 'symlink') {
    try {
      const validated = await validateExistingPathDetailed(entry.path, signal);
      return !isSensitivePath(validated.requestedPath, validated.resolvedPath);
    } catch {
      return false;
    }
  }

  const resolvedPath = normalizePath(entry.path);
  if (!isPathWithinDirectories(resolvedPath, rootDirectories)) {
    return false;
  }
  return !isSensitivePath(entry.path, resolvedPath);
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

const collator = new Intl.Collator(undefined, { numeric: true });

function compareString(a?: string, b?: string): number {
  return collator.compare(a ?? '', b ?? '');
}

function compareNameThenPath(a: Sortable, b: Sortable): number {
  const nameCompare = compareString(a.name, b.name);
  if (nameCompare !== 0) return nameCompare;
  return compareString(a.path, b.path);
}

function comparePathThenName(a: Sortable, b: Sortable): number {
  const pathCompare = compareString(a.path, b.path);
  if (pathCompare !== 0) return pathCompare;
  return compareString(a.name, b.name);
}

function compareOptionalNumberDesc(
  left: number | undefined,
  right: number | undefined,
  tieBreak: () => number
): number {
  const diff = (right ?? 0) - (left ?? 0);
  if (diff !== 0) return diff;
  return tieBreak();
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
    const decorated: { item: Sortable; baseName: string; index: number }[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const item = results[index];
      if (!item) continue;
      decorated.push({
        item,
        baseName: path.basename(item.path ?? ''),
        index,
      });
    }
    decorated.sort((a, b) => {
      const baseCompare = compareString(a.baseName, b.baseName);
      if (baseCompare !== 0) return baseCompare;
      const pathCompare = compareString(a.item.path, b.item.path);
      if (pathCompare !== 0) return pathCompare;
      return a.index - b.index;
    });
    for (let index = 0; index < decorated.length; index += 1) {
      const entry = decorated[index];
      if (entry) {
        results[index] = entry.item;
      }
    }
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
  const { signal, cleanup } = createTimedAbortSignal(
    options.signal,
    normalized.timeoutMs
  );
  const root = await validateExistingDirectory(basePath, signal);

  try {
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
  } finally {
    cleanup();
  }
}
