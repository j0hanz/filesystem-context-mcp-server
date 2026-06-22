import { basename } from 'node:path';

import { withTimedAbortSignal } from '../concurrency.js';
import { ErrorCode, FsError, isTimeoutLikeError } from '../errors.js';
import {
  buildGlobOptions,
  compareOptionalNumberDesc,
  compareStringValues,
  DEFAULT_EXCLUDE_PATTERNS,
  type DirentLike,
  type EntryAccessDependencies,
  type EntryType,
  type FileType,
  globEntries,
  isEntryAccessibleByType,
  needsStatsForSort,
  resolveEntryType,
  resolveStopReason,
  stableSortByDerivedString,
  type Stats,
  withOptionalStoppedReason,
} from '../fs.js';
import type { GuardedFileSystem } from '../fs.js';
import type { PathGuard } from '../path.js';
import { isPathWithinDirectories, normalizePath } from '../path.js';
import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCHABLE_FILE_SIZE,
} from '../util.js';
import { buildMatcher, executeSearch as executeCoreSearch } from './engine.js';
import type { SearchOptions } from './engine.js';

// ---------------------------------------------------------------------------
// Content Search Types & Defaults
// ---------------------------------------------------------------------------

interface ContentMatch {
  readonly file: string;
  readonly line: number;
  readonly content: string;
  readonly contextBefore?: readonly string[];
  readonly contextAfter?: readonly string[];
  readonly matchCount: number;
}

export interface SearchContentResult {
  readonly basePath: string;
  readonly pattern: string;
  readonly filePattern: string;
  readonly matches: readonly ContentMatch[];
  readonly summary: {
    readonly filesScanned: number;
    readonly filesMatched: number;
    readonly matches: number;
    readonly truncated: boolean;
    readonly skippedTooLarge: number;
    readonly skippedBinary: number;
    readonly skippedInaccessible: number;
    readonly stoppedReason?: 'maxResults' | 'maxFiles' | 'timeout';
  };
}

export interface SearchContentOptions {
  filePattern?: string;
  excludePatterns?: string[];
  caseSensitive?: boolean;
  maxResults?: number;
  maxFileSize?: number;
  maxFilesScanned?: number;
  timeoutMs?: number;
  skipBinary?: boolean;
  contextLines?: number;
  contextBefore?: number;
  contextAfter?: number;
  fuzzy?: boolean;
  wholeWord?: boolean;
  isLiteral?: boolean;
  includeHidden?: boolean;
  baseNameMatch?: boolean;
  caseSensitiveFileMatch?: boolean;
  respectGitignore?: boolean;
  signal?: AbortSignal;
  maxDepth?: number;
  onProgress?: (progress: { total?: number; current: number }) => void;
}

const SEARCH_CONTENT_DEFAULTS = {
  filePattern: '**/*',
  excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
  caseSensitive: false,
  maxResults: DEFAULT_SEARCH_CONTENT_RESULTS,
  maxFileSize: MAX_SEARCHABLE_FILE_SIZE,
  maxFilesScanned: DEFAULT_SEARCH_MAX_FILES,
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  skipBinary: true,
  contextLines: 0,
  wholeWord: false,
  isLiteral: true,
  includeHidden: false,
  baseNameMatch: true,
  caseSensitiveFileMatch: true,
  respectGitignore: true,
};

const MIN_FUZZY_PATTERN_LENGTH = 4;

function resolveSearchContentOptions(options: SearchContentOptions) {
  return {
    filePattern: options.filePattern ?? SEARCH_CONTENT_DEFAULTS.filePattern,
    excludePatterns: options.excludePatterns ?? SEARCH_CONTENT_DEFAULTS.excludePatterns,
    caseSensitive: options.caseSensitive ?? SEARCH_CONTENT_DEFAULTS.caseSensitive,
    maxResults: options.maxResults ?? SEARCH_CONTENT_DEFAULTS.maxResults,
    maxFileSize: options.maxFileSize ?? SEARCH_CONTENT_DEFAULTS.maxFileSize,
    maxFilesScanned: options.maxFilesScanned ?? SEARCH_CONTENT_DEFAULTS.maxFilesScanned,
    timeoutMs: options.timeoutMs ?? SEARCH_CONTENT_DEFAULTS.timeoutMs,
    skipBinary: options.skipBinary ?? SEARCH_CONTENT_DEFAULTS.skipBinary,
    contextLines: options.contextLines ?? SEARCH_CONTENT_DEFAULTS.contextLines,
    wholeWord: options.wholeWord ?? SEARCH_CONTENT_DEFAULTS.wholeWord,
    isLiteral: options.isLiteral ?? SEARCH_CONTENT_DEFAULTS.isLiteral,
    includeHidden: options.includeHidden ?? SEARCH_CONTENT_DEFAULTS.includeHidden,
    baseNameMatch: options.baseNameMatch ?? SEARCH_CONTENT_DEFAULTS.baseNameMatch,
    caseSensitiveFileMatch:
      options.caseSensitiveFileMatch ?? SEARCH_CONTENT_DEFAULTS.caseSensitiveFileMatch,
    respectGitignore: options.respectGitignore ?? SEARCH_CONTENT_DEFAULTS.respectGitignore,
    fuzzy: options.fuzzy,
    contextBefore: options.contextBefore,
    contextAfter: options.contextAfter,
    maxDepth: options.maxDepth,
  };
}

function buildTimeoutSearchResult(
  basePath: string,
  pattern: string,
  filePattern: string,
): SearchContentResult {
  return {
    basePath,
    pattern,
    filePattern,
    matches: [],
    summary: {
      filesScanned: 0,
      filesMatched: 0,
      matches: 0,
      truncated: true,
      skippedTooLarge: 0,
      skippedBinary: 0,
      skippedInaccessible: 0,
      stoppedReason: 'timeout',
    },
  };
}

// ---------------------------------------------------------------------------
// File Search Types & Defaults
// ---------------------------------------------------------------------------

type SortBy = 'name' | 'size' | 'modified' | 'path';

interface SearchResult {
  readonly path: string;
  readonly type: FileType;
  readonly size?: number;
  readonly modified?: Date;
}

type SearchFilesStopReason = 'maxResults' | 'maxFiles' | 'timeout';

export interface SearchFilesResult {
  readonly basePath: string;
  readonly pattern: string;
  readonly results: readonly SearchResult[];
  readonly summary: {
    readonly matched: number;
    readonly truncated: boolean;
    readonly skippedInaccessible: number;
    readonly filesScanned: number;
    readonly stoppedReason?: SearchFilesStopReason;
  };
}

export interface SearchFilesOptions {
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

const SEARCH_FILES_MAX_RESULTS = 1000;

type SearchFilesNormalized = Required<
  Omit<SearchFilesOptions, 'maxDepth' | 'sortBy' | 'signal' | 'onProgress'>
> & {
  maxDepth?: number;
  sortBy: NonNullable<SearchFilesOptions['sortBy']>;
};

function normalizeSearchFilesOptions(options: SearchFilesOptions): SearchFilesNormalized {
  const normalized: SearchFilesNormalized = {
    maxResults: options.maxResults ?? SEARCH_FILES_MAX_RESULTS,
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
  stoppedReason?: SearchFilesStopReason;
  skippedInaccessible: number;
}

interface CollectOutcome {
  results: SearchResult[];
  filesScanned: number;
  truncated: boolean;
  stoppedReason?: SearchFilesStopReason;
  skippedInaccessible: number;
}

const SEARCH_FILES_ACCESS_DEPS_BASE = {
  normalizePath,
  isPathWithinDirectories,
} as const;

// ---------------------------------------------------------------------------
// Main Implementation Exports
// ---------------------------------------------------------------------------

export async function searchContent(
  basePath: string,
  pattern: string,
  options: SearchContentOptions = {},
  pathGuard?: PathGuard,
  fsOps?: GuardedFileSystem,
): Promise<SearchContentResult> {
  if (!pathGuard) {
    throw new FsError(ErrorCode.INVALID_INPUT, 'pathGuard is required in searchContent');
  }
  if (!fsOps) {
    throw new FsError(ErrorCode.INVALID_INPUT, 'fsOps is required in searchContent');
  }
  if (!basePath.trim()) throw new FsError(ErrorCode.INVALID_INPUT, 'basePath required');
  if (typeof pattern !== 'string') throw new FsError(ErrorCode.INVALID_INPUT, 'pattern required');

  const opts = resolveSearchContentOptions(options);

  if (opts.fuzzy === true) {
    if (!opts.isLiteral) {
      throw new FsError(ErrorCode.INVALID_INPUT, "Cannot use 'fuzzy' with 'isRegex'");
    }
    if (pattern.length < MIN_FUZZY_PATTERN_LENGTH) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        `Fuzzy pattern must be at least ${MIN_FUZZY_PATTERN_LENGTH} characters`,
      );
    }
  }

  try {
    return await withTimedAbortSignal(options.signal, opts.timeoutMs, async (signal) => {
      const searchOpts: SearchOptions = {
        pattern,
        path: basePath,
        filePattern: opts.filePattern,
        excludePatterns: opts.excludePatterns,
        caseSensitive: opts.caseSensitive,
        wholeWord: opts.wholeWord,
        isLiteral: opts.isLiteral,
        maxResults: opts.maxResults,
        maxFileSize: opts.maxFileSize,
        maxFilesScanned: opts.maxFilesScanned,
        timeoutMs: opts.timeoutMs,
        skipBinary: opts.skipBinary,
        contextBefore: opts.contextBefore ?? opts.contextLines,
        contextAfter: opts.contextAfter ?? opts.contextLines,
        signal,
        baseNameMatch: opts.baseNameMatch,
        includeHidden: opts.includeHidden,
        respectGitignore: opts.respectGitignore,
        ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
        ...(opts.fuzzy !== undefined ? { fuzzy: opts.fuzzy } : {}),
      };

      const coreResult = await executeCoreSearch(fsOps, searchOpts);

      const matcher = buildMatcher(pattern, {
        caseSensitive: opts.caseSensitive,
        wholeWord: opts.wholeWord,
        isLiteral: opts.isLiteral,
        ...(opts.fuzzy !== undefined ? { fuzzy: opts.fuzzy } : {}),
      });

      const matches: ContentMatch[] = [];
      for (const fileMatch of coreResult.filesMatched) {
        for (const match of fileMatch.matches) {
          matches.push({
            file: fileMatch.filePath,
            line: match.line,
            content: match.content,
            contextBefore: match.before,
            contextAfter: match.after,
            matchCount: matcher.matchCount(match.content),
          });
        }
      }

      return {
        basePath,
        pattern,
        filePattern: opts.filePattern,
        matches,
        summary: {
          filesScanned: coreResult.summary.filesScanned,
          filesMatched: coreResult.summary.filesMatched,
          matches: coreResult.summary.matchesCount,
          truncated: coreResult.summary.truncated,
          skippedTooLarge: 0,
          skippedBinary: 0,
          skippedInaccessible: coreResult.summary.skippedFiles ?? 0,
          ...(coreResult.summary.truncated
            ? { stoppedReason: coreResult.summary.truncatedReason ?? ('maxResults' as const) }
            : {}),
        },
      };
    });
  } catch (error: unknown) {
    if (isTimeoutLikeError(error)) {
      return buildTimeoutSearchResult(basePath, pattern, opts.filePattern);
    }
    throw error;
  }
}

export async function searchFiles(
  basePath: string,
  pattern: string,
  excludePatterns: readonly string[] = [],
  options: SearchFilesOptions = {},
  pathGuard?: PathGuard,
): Promise<SearchFilesResult> {
  if (!pathGuard) {
    throw new FsError(ErrorCode.INVALID_INPUT, 'pathGuard is required in searchFiles');
  }
  const normalized = normalizeSearchFilesOptions(options);
  return withTimedAbortSignal(options.signal, normalized.timeoutMs, async (signal) => {
    const root = await pathGuard.validateExistingDirectory(basePath);
    const { results, summary } = await runSearchFiles(
      root,
      pattern,
      excludePatterns,
      normalized,
      signal,
      options.onProgress,
      pathGuard,
    );
    return { basePath: root, pattern, results, summary };
  });
}

// ---------------------------------------------------------------------------
// File Search Helper Routines
// ---------------------------------------------------------------------------

function buildSearchFilesResult(
  entry: { path: string; stats?: Stats },
  entryType: EntryType,
  needsStats: boolean,
): SearchResult {
  let resolvedType: SearchResult['type'] = 'other';
  if (entryType === 'directory') resolvedType = 'directory';
  else if (entryType === 'file') resolvedType = 'file';
  const size = needsStats && entry.stats?.isFile() ? entry.stats.size : undefined;
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
  normalized: SearchFilesNormalized,
  signal: AbortSignal,
): boolean {
  const stopReason = resolveStopReason<Exclude<SearchFilesStopReason, undefined>>({
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

function shouldIncludeEntry(entryType: EntryType, normalized: SearchFilesNormalized): boolean {
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
  normalized: SearchFilesNormalized,
  needsStats: boolean,
): AsyncIterable<SearchEntry> {
  return globEntries(
    buildGlobOptions({
      cwd: root,
      pattern,
      excludePatterns,
      includeHidden: normalized.includeHidden,
      baseNameMatch: normalized.baseNameMatch,
      caseSensitiveMatch: true,
      followSymbolicLinks: false,
      onlyFiles: true,
      stats: needsStats,
      suppressErrors: true,
      ...(normalized.maxDepth !== undefined ? { maxDepth: normalized.maxDepth } : {}),
    }),
  );
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

function handleSearchEntry(
  entry: SearchEntry,
  entryType: EntryType,
  needsStats: boolean,
  normalized: SearchFilesNormalized,
  state: CollectState,
): void {
  state.results.push(buildSearchFilesResult(entry, entryType, needsStats));
  if (state.results.length >= normalized.maxResults) {
    state.truncated = true;
    state.stoppedReason = 'maxResults';
  }
}

interface CollectStreamContext {
  rootDirectories: readonly string[];
  normalized: SearchFilesNormalized;
  needsStats: boolean;
  state: CollectState;
  accessDeps: EntryAccessDependencies;
  onProgress?: (progress: { total?: number; current: number }) => void;
}

async function collectFromStream(
  stream: AsyncIterable<SearchEntry>,
  signal: AbortSignal,
  context: CollectStreamContext,
): Promise<void> {
  const { rootDirectories, normalized, needsStats, state, accessDeps, onProgress } = context;

  for await (const entry of stream) {
    if (shouldStopCollecting(state, normalized, signal)) break;
    state.filesScanned++;
    onProgress?.({
      current: state.filesScanned,
      total: normalized.maxFilesScanned,
    });

    const entryType = resolveEntryType(entry.dirent);
    if (!shouldIncludeEntry(entryType, normalized)) continue;

    const isAccessible = await isEntryAccessibleByType(
      entry.path,
      entryType,
      rootDirectories,
      signal,
      accessDeps,
    );
    if (!isAccessible) {
      state.skippedInaccessible++;
      continue;
    }

    handleSearchEntry(entry, entryType, needsStats, normalized, state);
    if (state.truncated) break;
  }

  onProgress?.({
    current: state.filesScanned,
    total: normalized.maxFilesScanned,
  });
}

async function collectSearchResults(
  root: string,
  pattern: string,
  excludePatterns: readonly string[],
  normalized: SearchFilesNormalized,
  signal: AbortSignal,
  pathGuard: PathGuard,
  onProgress?: (progress: { total?: number; current: number }) => void,
): Promise<CollectOutcome> {
  const needsStats = needsStatsForSort(normalized.sortBy);
  const stream = buildSearchStream(root, pattern, excludePatterns, normalized, needsStats);
  const state = createCollectState();
  const rootDirectories = [root];

  const accessDeps = {
    ...SEARCH_FILES_ACCESS_DEPS_BASE,
    isSensitivePath: (reqPath: string, resPath: string) =>
      pathGuard.isSensitive(reqPath) || pathGuard.isSensitive(resPath),
    validateSymlinkPath: (p: string) => pathGuard.validateExistingPathDetailed(p),
  };

  await collectFromStream(stream, signal, {
    rootDirectories,
    normalized,
    needsStats,
    state,
    accessDeps,
    ...(onProgress ? { onProgress } : {}),
  });
  return buildCollectResult(state);
}

function buildSearchFilesSummary(
  results: SearchResult[],
  filesScanned: number,
  truncated: boolean,
  stoppedReason: SearchFilesStopReason | undefined,
  skippedInaccessible: number,
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

const SEARCH_FILES_SORT_COMPARATORS: Readonly<
  Record<SortBy, (a: Sortable, b: Sortable) => number>
> = {
  size: (a, b) => compareOptionalNumberDesc(a.size, b.size, () => compareNameThenPath(a, b)),
  modified: (a, b) =>
    compareOptionalNumberDesc(a.modified?.getTime(), b.modified?.getTime(), () =>
      compareNameThenPath(a, b),
    ),
  path: (a, b) => comparePathThenName(a, b),
  name: (a, b) => compareNameThenPath(a, b),
};

function sortSearchResults(results: Sortable[], sortBy: SortBy): void {
  if (sortBy === 'name') {
    stableSortByDerivedString(
      results,
      (item) => basename(item.path ?? ''),
      (left, right) => comparePathThenName(left, right),
    );
    return;
  }
  const comparator = SEARCH_FILES_SORT_COMPARATORS[sortBy];
  results.sort(comparator);
}

async function runSearchFiles(
  root: string,
  pattern: string,
  excludePatterns: readonly string[],
  normalized: SearchFilesNormalized,
  signal: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void,
  pathGuard?: PathGuard,
): Promise<{ results: SearchResult[]; summary: SearchFilesResult['summary'] }> {
  if (!pathGuard) {
    throw new FsError(ErrorCode.INVALID_INPUT, 'pathGuard is required in runSearchFiles');
  }
  const { results, filesScanned, truncated, stoppedReason, skippedInaccessible } =
    await collectSearchResults(
      root,
      pattern,
      excludePatterns,
      normalized,
      signal,
      pathGuard,
      onProgress,
    );

  sortSearchResults(results, normalized.sortBy);

  return {
    results,
    summary: buildSearchFilesSummary(
      results,
      filesScanned,
      truncated,
      stoppedReason,
      skippedInaccessible,
    ),
  };
}
