import { basename, relative } from 'node:path';

import * as z from 'zod/v4';

import { withTimedAbortSignal } from '../core/concurrency.js';
import { ErrorCode, FsError } from '../core/errors.js';
import { formatCount, truncateProgressPattern } from '../core/fmt.js';
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
} from '../core/fs.js';
import {
  decodeOffsetCursor,
  encodeOffsetCursor,
  isPathWithinDirectories,
  normalizePath,
  type PathGuard,
} from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import {
  assignDefined,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_DEPTH,
  MAX_SEARCH_RESULTS,
} from '../core/util.js';
import {
  CursorSchema,
  includeHiddenField,
  includeIgnoredField,
  IsoDateTime,
  NextCursorSchema,
  NonNegInt,
  OptionalPath,
  SafeGlobPattern,
} from '../schema.js';
import { putResource } from './_helpers.js';
import { defineTool } from './define.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

interface SearchResult {
  readonly path: string;
  readonly type: FileType;
  readonly size?: number;
  readonly modified?: Date;
}

interface SearchFilesResult {
  readonly basePath: string;
  readonly pattern: string;
  readonly results: readonly SearchResult[];
  readonly summary: {
    readonly matched: number;
    readonly truncated: boolean;
    readonly skippedInaccessible: number;
    readonly filesScanned: number;
    readonly stoppedReason?: 'maxResults' | 'maxFiles' | 'timeout';
  };
}

// ---------------------------------------------------------------------------
// Private searchFiles implementation
// ---------------------------------------------------------------------------

const SEARCH_FILES_ACCESS_DEPS_BASE = {
  normalizePath,
  isPathWithinDirectories,
} as const;

// Internal default for find tool - not exposed to MCP users
const SEARCH_FILES_MAX_RESULTS = 1000;

type SearchFilesStopReason = SearchFilesResult['summary']['stoppedReason'];

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

async function searchFiles(
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

const SearchFilesInputSchema = z.strictObject({
  path: OptionalPath.describe('Base directory to search under (default: first allowed root)'),
  pattern: SafeGlobPattern.describe('Glob pattern to match file paths (e.g. **/*.ts, src/**/*.js)'),
  maxResults: z
    .uint32()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .default(DEFAULT_SEARCH_RESULTS)
    .describe('Maximum number of matching files to return per page'),
  includeIgnored: includeIgnoredField(),
  includeHidden: includeHiddenField(),
  sortBy: z
    .enum(['name', 'size', 'modified', 'path'])
    .optional()
    .default('path')
    .describe(
      'Sort order: path = full path (default), name = basename only, size = bytes descending, modified = newest first',
    ),
  maxDepth: z
    .uint32()
    .min(0)
    .max(MAX_SEARCH_DEPTH)
    .optional()
    .describe('Max directory depth to scan; 0 = base directory only, omit for unlimited'),
  cursor: CursorSchema,
});

const SearchFilesOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Always true; call succeeded'),
  root: z.string().describe('Resolved base directory used as the search root'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('File path relative to the search root'),
        size: NonNegInt.optional().describe('File size in bytes (present when sortBy=size)'),
        modified: IsoDateTime.optional().describe(
          'Last modification time (present when sortBy=modified)',
        ),
      }),
    )
    .describe('Matched files ordered by sortBy'),
  totalMatches: NonNegInt.optional().describe('Total number of matching files found'),
  filesScanned: NonNegInt.optional().describe('Total number of files examined during the search'),
  skippedInaccessible: NonNegInt.optional().describe(
    'Files skipped due to permission or access errors',
  ),
  stoppedReason: z
    .enum(['maxResults', 'maxFiles', 'timeout'])
    .optional()
    .describe(
      'Why the search ended early: maxResults = result cap reached, maxFiles = scan cap reached, timeout = time limit hit',
    ),
  resourceUri: z
    .string()
    .optional()
    .describe(
      'URI to the full results JSON in the resource store (present when results are paginated)',
    ),
  nextCursor: NextCursorSchema,
});

function buildRelativeResults(
  basePath: string,
  displayResults: readonly { path: string; size?: number; modified?: Date }[],
): NonNullable<z.infer<typeof SearchFilesOutputSchema>['results']> {
  const relativeResults: NonNullable<z.infer<typeof SearchFilesOutputSchema>['results']> = [];
  for (const entry of displayResults) {
    relativeResults.push({
      path: relative(basePath, entry.path),
      size: entry.size,
      modified: entry.modified?.toISOString(),
    });
  }
  return relativeResults;
}

function computeNextCursor(
  summary: { truncated: boolean },
  displayResultsCount: number,
  cursorOffset: number,
): string | undefined {
  if (summary.truncated && displayResultsCount > 0) {
    return encodeOffsetCursor(cursorOffset + displayResultsCount);
  }
  return undefined;
}

function applySummaryFields(
  structured: z.infer<typeof SearchFilesOutputSchema>,
  summary: {
    truncated: boolean;
    skippedInaccessible: number;
    stoppedReason?: 'timeout' | 'maxResults' | 'maxFiles';
  },
  nextCursor?: string,
): void {
  assignDefined(structured, {
    skippedInaccessible: summary.skippedInaccessible || undefined,
    stoppedReason: summary.stoppedReason,
    nextCursor,
  });
}

async function handleSearchFiles(
  args: z.infer<typeof SearchFilesInputSchema>,
  pathGuard: PathGuard,
  signal?: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void,
  resourceStore?: ResourceStore,
): Promise<{
  structured: z.infer<typeof SearchFilesOutputSchema>;
  link?: ReturnType<typeof putResource>['link'];
  count: number;
}> {
  const basePath = pathGuard.resolvePathOrRoot(args.path);
  const excludePatterns = args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS;
  const cursorOffset = args.cursor !== undefined ? decodeOffsetCursor(args.cursor) : 0;
  const pageSize = args.maxResults;
  const fetchMax = cursorOffset + pageSize;
  const searchOptions: Parameters<typeof searchFiles>[3] = {
    maxResults: fetchMax,
    includeHidden: args.includeHidden,
    sortBy: args.sortBy,
    respectGitignore: !args.includeIgnored,
  };
  assignDefined(searchOptions, {
    maxDepth: args.maxDepth,
    onProgress,
    signal,
  });
  const result = await searchFiles(
    basePath,
    args.pattern,
    excludePatterns,
    searchOptions,
    pathGuard,
  );
  const allResults = result.results;
  let displayResults = allResults;
  if (cursorOffset > 0) displayResults = allResults.slice(cursorOffset);

  const nextCursor = computeNextCursor(result.summary, displayResults.length, cursorOffset);
  const relativeResults = buildRelativeResults(result.basePath, displayResults);
  const structured: z.infer<typeof SearchFilesOutputSchema> = {
    ok: true,
    root: basePath,
    results: relativeResults,
    totalMatches: result.summary.matched,
    filesScanned: result.summary.filesScanned,
  };
  applySummaryFields(structured, result.summary, nextCursor);

  // If resourceStore is available, store results as JSON and build resource response
  if (resourceStore !== undefined && relativeResults.length > 0) {
    const resultsJson = JSON.stringify(relativeResults, null, 2);
    const { entry, link } = putResource({
      store: resourceStore,
      name: `${args.pattern} files`,
      mimeType: 'application/json',
      kind: 'text',
      content: resultsJson,
    });

    return {
      structured: {
        ...structured,
        resourceUri: entry.uri,
      },
      link,
      count: relativeResults.length,
    };
  }

  return { structured, count: relativeResults.length };
}

export const SEARCH_FILES = defineTool({
  name: 'find_files',
  title: 'Find Files',
  description:
    'Find files matching a glob pattern. Returns matched paths with optional metadata. ' +
    'Pagination: cursors are offset-based and re-run the full query per page. ' +
    'For content search use search_text; for bulk regex replacements use replace_text with the same glob.',
  input: SearchFilesInputSchema,
  output: SearchFilesOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execution: { taskSupport: 'forbidden' },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  nuances: [
    'Respects .gitignore by default; set includeIgnored=true to include ignored files.',
    'Result paths are relative to the search root, not the workspace root.',
  ],
  gotchas: [
    'Bare filename patterns (e.g. README.md) match only at the root; prefix with **/ (e.g. **/README.md) for a recursive match.',
  ],
  defaultErrorCode: ErrorCode.UNKNOWN,
  progress: (args) => ({
    label: 'Find',
    subject: truncateProgressPattern(args.pattern),
  }),
  progressDone: (_args, result) => ({
    detail: formatCount(result.totalMatches ?? 0, 'match', 'matches'),
  }),
  run: async (args, ctx) => {
    const onProgress = (params: { current: number; total?: number }): void => {
      ctx.onProgress?.({
        current: params.current,
        ...(params.total !== undefined ? { total: params.total } : {}),
      });
    };
    const { structured, link } = await handleSearchFiles(
      args,
      ctx.pathGuard,
      ctx.signal,
      onProgress,
      ctx.resourceStore,
    );
    const text =
      structured.results.length > 0
        ? structured.results.map((r) => r.path).join('\n')
        : `No files matching '${args.pattern}'`;
    if (link) {
      return { structured, text, resources: [link] };
    }
    return { structured, text };
  },
});
