import type { Stats } from 'node:fs';
import { basename, relative } from 'node:path';

import type { z } from 'zod/v4';

import { withTimedAbortSignal } from '../lib/abort.js';
import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import {
  buildGlobOptions,
  compareOptionalNumberDesc,
  compareStringValues,
  type DirentLike,
  type EntryType,
  globEntries,
  isEntryAccessibleByType,
  isIgnoredByGitignore,
  loadRootGitignore,
  needsStatsForSort,
  resolveEntryType,
  resolveStopReason,
  stableSortByDerivedString,
  withOptionalStoppedReason,
} from '../lib/fs-walk.js';
import {
  isPathWithinDirectories,
  isSensitivePath,
  normalizePath,
  validateExistingDirectory,
  validateExistingPathDetailed,
} from '../lib/paths.js';
import { assignDefined } from '../lib/utils.js';

import type { SearchFilesResult, SearchResult } from '../config.js';
import { formatOperationSummary, joinLines } from '../config.js';
import { SearchFilesInputSchema, SearchFilesOutputSchema } from '../schemas.js';
import { defineTool } from './define-tool.js';
import { DIRECTORY_ICONS } from './icons.js';
import {
  buildToolResponse,
  decodeOffsetCursor,
  encodeOffsetCursor,
  READ_ONLY_TOOL_ANNOTATIONS,
  resolvePathOrRoot,
  type ToolContract,
  type ToolResponse,
  truncateProgressPattern,
} from './shared.js';
import {
  resolveFinalProgressCurrent,
  runWithProgressSession,
} from './tool-execution.js';

// ---------------------------------------------------------------------------
// Private searchFiles implementation (inlined from lib/file-operations/search.ts)
// ---------------------------------------------------------------------------

const SEARCH_FILES_ACCESS_DEPS = {
  normalizePath,
  isPathWithinDirectories,
  isSensitivePath,
  validateSymlinkPath: validateExistingPathDetailed,
} as const;

// Internal default for find tool - not exposed to MCP users
const SEARCH_FILES_MAX_RESULTS = 1000;

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

type SearchFilesStopReason = SearchFilesResult['summary']['stoppedReason'];

function normalizeSearchFilesOptions(
  options: SearchFilesOptions
): SearchFilesNormalized {
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
  needsStats: boolean
): SearchResult {
  let resolvedType: SearchResult['type'] = 'other';
  if (entryType === 'directory') resolvedType = 'directory';
  else if (entryType === 'file') resolvedType = 'file';
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
  normalized: SearchFilesNormalized,
  signal: AbortSignal
): boolean {
  const stopReason = resolveStopReason<
    Exclude<SearchFilesStopReason, undefined>
  >({
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
  normalized: SearchFilesNormalized
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
  normalized: SearchFilesNormalized,
  needsStats: boolean
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
      ...(normalized.maxDepth !== undefined
        ? { maxDepth: normalized.maxDepth }
        : {}),
    })
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
  state: CollectState
): void {
  state.results.push(buildSearchFilesResult(entry, entryType, needsStats));
  if (state.results.length >= normalized.maxResults) {
    state.truncated = true;
    state.stoppedReason = 'maxResults';
  }
}

interface CollectStreamContext {
  root: string;
  rootDirectories: readonly string[];
  gitignoreMatcher: Awaited<ReturnType<typeof loadRootGitignore>>;
  normalized: SearchFilesNormalized;
  needsStats: boolean;
  state: CollectState;
  accessDeps: typeof SEARCH_FILES_ACCESS_DEPS;
  onProgress?: (progress: { total?: number; current: number }) => void;
}

async function collectFromStream(
  stream: AsyncIterable<SearchEntry>,
  signal: AbortSignal,
  context: CollectStreamContext
): Promise<void> {
  const {
    root,
    rootDirectories,
    gitignoreMatcher,
    normalized,
    needsStats,
    state,
    accessDeps,
    onProgress,
  } = context;

  for await (const entry of stream) {
    if (shouldStopCollecting(state, normalized, signal)) break;
    state.filesScanned++;
    onProgress?.({
      current: state.filesScanned,
      total: normalized.maxFilesScanned,
    });

    if (
      gitignoreMatcher &&
      isIgnoredByGitignore(
        gitignoreMatcher,
        root,
        entry.path,
        entry.relativePath ? { relativePath: entry.relativePath } : {}
      )
    ) {
      continue;
    }

    const entryType = resolveEntryType(entry.dirent);
    if (!shouldIncludeEntry(entryType, normalized)) continue;

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

  await collectFromStream(stream, signal, {
    root,
    rootDirectories,
    gitignoreMatcher,
    normalized,
    needsStats,
    state,
    accessDeps: SEARCH_FILES_ACCESS_DEPS,
    ...(onProgress ? { onProgress } : {}),
  });
  return buildCollectResult(state);
}

function buildSearchFilesSummary(
  results: SearchResult[],
  filesScanned: number,
  truncated: boolean,
  stoppedReason: SearchFilesStopReason | undefined,
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

const SEARCH_FILES_SORT_COMPARATORS: Readonly<
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

function sortSearchResults(results: Sortable[], sortBy: SortBy): void {
  if (sortBy === 'name') {
    stableSortByDerivedString(
      results,
      (item) => basename(item.path ?? ''),
      (left, right) => comparePathThenName(left, right)
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
    summary: buildSearchFilesSummary(
      results,
      filesScanned,
      truncated,
      stoppedReason,
      skippedInaccessible
    ),
  };
}

async function searchFiles(
  basePath: string,
  pattern: string,
  excludePatterns: readonly string[] = [],
  options: SearchFilesOptions = {}
): Promise<SearchFilesResult> {
  const normalized = normalizeSearchFilesOptions(options);
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
      return { basePath: root, pattern, results, summary };
    }
  );
}

// ---------------------------------------------------------------------------

const SEARCH_FILES_TOOL: ToolContract = {
  name: 'find',
  title: 'Find Files',
  description:
    'Find files by glob pattern (e.g. `**/*.ts`). Returns matching files with metadata. ' +
    'Cursors are offset-based: each page re-runs the query from the stored offset. ' +
    'For content search, use `grep`. For bulk edits, pass the same glob to `search_and_replace`.',
  inputSchema: SearchFilesInputSchema,
  outputSchema: SearchFilesOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: DIRECTORY_ICONS,
  nuances: [
    'Respects `.gitignore` unless `includeIgnored=true`.',
    'Result paths are relative to the search root, not the workspace root.',
  ],
  gotchas: [
    'Bare names match only at the root; use `**/README.md` for recursive match.',
  ],
  taskSupport: 'optional',
  defaultTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
} as const;

function buildTruncatedReason(summary: {
  truncated: boolean;
  stoppedReason?: string;
  filesScanned: number;
  matched: number;
}): string | undefined {
  if (!summary.truncated) return undefined;
  if (summary.stoppedReason === 'timeout') return 'timeout';
  if (summary.stoppedReason === 'maxFiles')
    return `max files (${summary.filesScanned})`;
  return `max results (${summary.matched})`;
}

function buildRelativeResults(
  basePath: string,
  displayResults: readonly { path: string; size?: number; modified?: Date }[]
): NonNullable<z.infer<typeof SearchFilesOutputSchema>['results']> {
  const relativeResults: NonNullable<
    z.infer<typeof SearchFilesOutputSchema>['results']
  > = [];
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
  cursorOffset: number
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
  nextCursor?: string
): void {
  assignDefined(structured, {
    skippedInaccessible: summary.skippedInaccessible || undefined,
    stoppedReason: summary.stoppedReason,
    nextCursor,
  });
}

async function handleSearchFiles(
  args: z.infer<typeof SearchFilesInputSchema>,
  signal?: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<ToolResponse<z.infer<typeof SearchFilesOutputSchema>>> {
  const basePath = resolvePathOrRoot(args.path);
  const excludePatterns = args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS;
  const cursorOffset =
    args.cursor !== undefined ? decodeOffsetCursor(args.cursor) : 0;
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
    searchOptions
  );
  const allResults = result.results;
  let displayResults = allResults;
  if (cursorOffset > 0) displayResults = allResults.slice(cursorOffset);

  const nextCursor = computeNextCursor(
    result.summary,
    displayResults.length,
    cursorOffset
  );
  const relativeResults = buildRelativeResults(result.basePath, displayResults);
  const structured: z.infer<typeof SearchFilesOutputSchema> = {
    ok: true,
    root: basePath,
    results: relativeResults,
    totalMatches: result.summary.matched,
    filesScanned: result.summary.filesScanned,
  };
  applySummaryFields(structured, result.summary, nextCursor);

  const truncatedReason = buildTruncatedReason(result.summary);

  const summaryOptions: Parameters<typeof formatOperationSummary>[0] = {
    truncated: result.summary.truncated,
  };
  if (truncatedReason) summaryOptions.truncatedReason = truncatedReason;

  const textLines: string[] = [];
  if (relativeResults.length === 0) {
    textLines.push('No matches');
  } else {
    textLines.push(`Found ${relativeResults.length}:`);
    for (const entry of relativeResults) {
      textLines.push(`  ${entry.path}`);
    }
  }

  let text = joinLines(textLines) + formatOperationSummary(summaryOptions);
  if (nextCursor) {
    text += `\n[Next page available. Use cursor: "${nextCursor}"]`;
  }
  return buildToolResponse(text, structured);
}

export const SEARCH_FILES = defineTool<
  z.infer<typeof SearchFilesInputSchema>,
  z.infer<typeof SearchFilesOutputSchema>
>({
  contract: SEARCH_FILES_TOOL,
  defaultErrorCode: ErrorCode.UNKNOWN,
  diagnosticsContext: (args) => ({ path: args.path ?? '.' }),
  run: async (args, ctx) => {
    const rawScopeLabel = args.path ? basename(args.path) : '.';
    const scopeLabel = rawScopeLabel || '.';
    const { pattern } = args;
    const truncatedPattern = truncateProgressPattern(pattern);
    const context = `${truncatedPattern} in ${scopeLabel}`;
    const label = `${SEARCH_FILES_TOOL.title}: ${context}`;

    return runWithProgressSession(ctx, label, async (progress) => {
      const progressWithMessage = ({
        current,
        total,
      }: {
        total?: number;
        current: number;
      }): void => {
        progress.update({
          current,
          ...(total !== undefined ? { total } : {}),
          message: `${SEARCH_FILES_TOOL.title}: ${truncatedPattern} [${current} files]`,
        });
      };

      const result = await handleSearchFiles(
        args,
        ctx.signal,
        progressWithMessage
      );
      const sc = result.structuredContent;
      const { totalMatches = 0, stoppedReason } = sc;

      let suffix: string;
      if (totalMatches === 0) {
        suffix = 'No matches';
      } else {
        suffix = `${totalMatches} ${totalMatches === 1 ? 'match' : 'matches'}`;
        if (stoppedReason === 'timeout') {
          suffix += ' [timeout]';
        } else if (stoppedReason === 'maxResults') {
          suffix += ' [max results]';
        } else if (stoppedReason === 'maxFiles') {
          suffix += ' [max files]';
        }
      }

      const finalCurrent = resolveFinalProgressCurrent(
        progress,
        (sc.filesScanned ?? 0) + 1
      );
      return { value: result, suffix, finalCurrent };
    });
  },
});
