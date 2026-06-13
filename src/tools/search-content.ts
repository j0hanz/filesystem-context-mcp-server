import { relative } from 'node:path';

import * as z from 'zod/v4';
import RE2 from 're2';

import { withTimedAbortSignal } from '../core/concurrency.js';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  FsError,
  isTimeoutLikeError,
} from '../core/errors.js';
import { DEFAULT_EXCLUDE_PATTERNS, type GuardedFileSystem } from '../core/fs.js';
import type { PathGuard } from '../core/path.js';
import {
  buildMatcher,
  executeSearch as executeCoreSearch,
  SearchWorkerPool,
} from '../core/search/engine.js';
import type { SearchOptions } from '../core/search/engine.js';
import type { ResourceStore } from '../core/store.js';
import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_DEPTH,
  MAX_SEARCH_RESULTS,
  MAX_SEARCHABLE_FILE_SIZE,
  omitOptionKeys,
  parseEnvInt,
} from '../core/util.js';
import {
  CursorSchema,
  defaultFalseBoolean,
  includeHiddenField,
  includeIgnoredField,
  NextCursorSchema,
  NonNegInt,
  OptionalPath,
  PositiveInt,
  SafeGlobPattern,
} from '../schema.js';
import {
  decodeOffsetCursor,
  encodeOffsetCursor,
  formatCount,
  putResource,
  truncateProgressPattern,
} from './_helpers.js';
import { defineTool } from './define.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

interface ContentMatch {
  readonly file: string;
  readonly line: number;
  readonly content: string;
  readonly contextBefore?: readonly string[];
  readonly contextAfter?: readonly string[];
  readonly matchCount: number;
}

interface SearchContentResult {
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

// ---------------------------------------------------------------------------
// Re-export SearchWorkerPool for compatibility
// ---------------------------------------------------------------------------
export { SearchWorkerPool };

const SEARCH_CONTENT_MAX_RESULTS = 500;

const SearchOptionsSchema = z.strictObject({
  filePattern: SafeGlobPattern,
  excludePatterns: z.array(z.string()),
  caseSensitive: z.boolean(),
  maxResults: NonNegInt,
  maxFileSize: NonNegInt,
  maxFilesScanned: NonNegInt,
  timeoutMs: NonNegInt,
  skipBinary: z.boolean(),
  contextLines: NonNegInt,
  contextBefore: z.int32().min(0).max(20).optional(),
  contextAfter: z.int32().min(0).max(20).optional(),
  fuzzy: z.boolean().optional(),
  wholeWord: z.boolean(),
  isLiteral: z.boolean(),
  includeHidden: z.boolean(),
  baseNameMatch: z.boolean(),
  caseSensitiveFileMatch: z.boolean(),
  respectGitignore: z.boolean(),
});

type ResolvedOptions = z.infer<typeof SearchOptionsSchema>;

interface SearchContentOptions extends Partial<ResolvedOptions> {
  signal?: AbortSignal;
  onProgress?: (progress: { total?: number; current: number }) => void;
  maxDepth?: number;
}

const SEARCH_CONTENT_DEFAULTS: ResolvedOptions = {
  filePattern: '**/*',
  excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
  caseSensitive: false,
  maxResults: SEARCH_CONTENT_MAX_RESULTS,
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

function mergeOptions(
  defaults: ResolvedOptions,
  options: Partial<ResolvedOptions>,
): ResolvedOptions {
  return { ...defaults, ...options };
}

function resolveOptions(options: SearchContentOptions): ResolvedOptions {
  const normalizedOptions = omitOptionKeys(options, ['signal', 'onProgress', 'maxDepth']);
  const merged = mergeOptions(SEARCH_CONTENT_DEFAULTS, normalizedOptions);
  const result = SearchOptionsSchema.safeParse(merged);
  if (!result.success) {
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      `Invalid search options:\n${z.prettifyError(result.error)}`,
      undefined,
      { errors: z.treeifyError(result.error) },
    );
  }
  return result.data;
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

async function searchContent(
  basePath: string,
  pattern: string,
  options: SearchContentOptions = {},
  pathGuard?: PathGuard,
  fsOps?: GuardedFileSystem,
): Promise<SearchContentResult> {
  if (!pathGuard) {
    throw new Error('pathGuard is required in searchContent');
  }
  if (!fsOps) {
    throw new Error('fsOps is required in searchContent');
  }
  if (!basePath.trim()) throw new FsError(ErrorCode.INVALID_INPUT, 'basePath required');
  if (typeof pattern !== 'string') throw new FsError(ErrorCode.INVALID_INPUT, 'pattern required');

  const opts = resolveOptions(options);

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
        ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
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
          skippedInaccessible: 0,
          ...(coreResult.summary.truncated ? { stoppedReason: 'maxResults' as const } : {}),
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

// ---------------------------------------------------------------------------

/**
 * Configuration constants for the Search Content tool.
 */
const CONFIG = {
  MAX_INLINE_MATCHES: parseEnvInt('FS_CONTEXT_MAX_INLINE_MATCHES', 50, 1, 10_000),
  COMPLETION_LABELS: {
    timeout: 'timeout',
    maxResults: 'max results',
    maxFiles: 'max files',
  } as const,
} as const;

// Type Definitions
type SearchInput = z.infer<typeof GrepInputSchema>;
type SearchOutput = z.infer<typeof GrepOutputSchema>;
type SearchMatchPayload = NonNullable<SearchOutput['matches']>[number];
type SearchResultValue = Awaited<ReturnType<typeof searchContent>>;
type SearchSummary = SearchResultValue['summary'];
type TruthySummaryField =
  | 'filesMatched'
  | 'skippedTooLarge'
  | 'skippedBinary'
  | 'skippedInaccessible';

interface SearchPreviewState {
  needsExternalize: boolean;
  visiblePayloads: SearchMatchPayload[];
  heading: string;
}

interface SearchContext {
  pattern: string;
  matcher?: RE2;
  caseSensitive: boolean;
  foldedPattern?: string;
}

const TRUTHY_SUMMARY_FIELDS: readonly TruthySummaryField[] = [
  'filesMatched',
  'skippedTooLarge',
  'skippedBinary',
  'skippedInaccessible',
];

function buildStructuredSummaryFields(summary: SearchSummary): Partial<SearchOutput> {
  const result: Partial<SearchOutput> = {};
  for (const key of TRUTHY_SUMMARY_FIELDS) {
    const value = summary[key];
    if (value) {
      result[key] = value;
    }
  }
  if (summary.truncated) {
    result.truncated = true;
  }
  if (summary.stoppedReason) {
    result.stoppedReason = summary.stoppedReason;
  }
  return result;
}
function buildSearchPreviewState(payloads: SearchMatchPayload[]): SearchPreviewState {
  const needsExternalize = payloads.length > CONFIG.MAX_INLINE_MATCHES;
  const visibleCount = needsExternalize ? CONFIG.MAX_INLINE_MATCHES : payloads.length;

  return {
    needsExternalize,
    visiblePayloads: payloads.slice(0, visibleCount),
    heading: buildHeading(payloads.length, visibleCount),
  };
}

const GrepInputSchema = z.strictObject({
  path: OptionalPath,
  pattern: SafeGlobPattern.optional().describe('File glob filter (default: all text files)'),
  searchPattern: z
    .string()
    .min(1)
    .max(10000)
    .describe(
      'Text or regex to search for (RE2: no lookahead/lookbehind/backrefs when isRegex=true)',
    )
    .meta({ examples: ['TODO', 'function\\s+(\\w+)', 'import.*from'] }),
  isRegex: defaultFalseBoolean('Treat searchPattern as regex'),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  caseSensitive: defaultFalseBoolean('Case-sensitive'),
  wholeWord: defaultFalseBoolean('Match whole words only'),
  contextLines: z
    .int32()
    .min(0)
    .max(20)
    .optional()
    .describe(
      'Lines of context before AND after each match (symmetric; overridden by contextBefore/contextAfter)',
    ),
  contextBefore: z
    .int32()
    .min(0)
    .max(20)
    .optional()
    .describe('Lines of context before each match (overrides contextLines for before)'),
  contextAfter: z
    .int32()
    .min(0)
    .max(20)
    .optional()
    .describe('Lines of context after each match (overrides contextLines for after)'),
  fuzzy: z
    .boolean()
    .optional()
    .describe(
      'Approximate string matching (Levenshtein-based, \u226425% char difference). Incompatible with isRegex.',
    ),

  maxResults: z
    .uint32()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .default(DEFAULT_SEARCH_CONTENT_RESULTS)
    .describe('Max matches to return per page'),
  maxDepth: z.uint32().min(0).max(MAX_SEARCH_DEPTH).optional().describe('Max directory depth'),
  cursor: CursorSchema,
});

const GrepOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  matches: z
    .array(
      z.strictObject({
        file: z.string().describe('Relative file path'),
        line: PositiveInt.describe('Line number'),
        column: NonNegInt.optional().describe('Column (0-indexed)'),
        content: z.string().describe('Matched line content'),
        matchCount: NonNegInt.optional().describe('Match count on this line'),
        contextBefore: z.array(z.string()).optional().describe('Context lines before'),
        contextAfter: z.array(z.string()).optional().describe('Context lines after'),
      }),
    )
    .describe('Flat list of matches (sorted by file then line)'),
  totalMatches: NonNegInt.optional().describe('Total match count'),
  filesMatched: NonNegInt.optional().describe('Files with matches'),
  filesScanned: NonNegInt.optional().describe('Files scanned'),
  skippedTooLarge: NonNegInt.optional().describe('Files skipped (too large)'),
  skippedBinary: NonNegInt.optional().describe('Files skipped (binary)'),
  skippedInaccessible: NonNegInt.optional().describe('Files skipped (inaccessible)'),
  truncated: z.boolean().optional().describe('Results truncated'),
  stoppedReason: z
    .enum(['maxResults', 'maxFiles', 'timeout'])
    .optional()
    .describe('Why search stopped early'),
  resourceUri: z.string().optional().describe('Full results URI when truncated'),
  nextCursor: NextCursorSchema,
});

function buildHeading(totalMatches: number, visibleMatches: number): string {
  if (visibleMatches >= totalMatches) {
    return `Found ${totalMatches}:`;
  }

  return `Found ${totalMatches} (showing first ${visibleMatches}):`;
}

function buildSearchMatchDetail(totalMatches: number, filesMatched: number): string {
  const matchDetail = formatCount(totalMatches, 'match', 'matches');
  if (filesMatched <= 0) return matchDetail;
  return `${matchDetail} · ${formatCount(filesMatched, 'file', 'files')}`;
}

function buildSearchStructured(
  summary: SearchSummary,
  matches: SearchMatchPayload[],
): SearchOutput {
  return {
    ok: true,
    matches,
    totalMatches: summary.matches,
    filesScanned: summary.filesScanned,
    ...buildStructuredSummaryFields(summary),
  };
}

function buildSortedPayloads(
  result: SearchResultValue,
  context: SearchContext,
): SearchMatchPayload[] {
  const relativeByFile = new Map<string, string>();

  const getRelativeFile = (file: string): string => {
    const cached = relativeByFile.get(file);
    if (cached !== undefined) return cached;

    const rel = relative(result.basePath, file);
    relativeByFile.set(file, rel);
    return rel;
  };

  const payloads = result.matches.map((match, originalIndex) => {
    const relFile = getRelativeFile(match.file);
    const column = findColumnOffset(match.content, context);

    const payload: SearchMatchPayload = {
      file: relFile,
      line: match.line,
      ...(column !== undefined ? { column } : {}),
      content: match.content,
      matchCount: match.matchCount,
      ...(match.contextBefore ? { contextBefore: [...match.contextBefore] } : {}),
      ...(match.contextAfter ? { contextAfter: [...match.contextAfter] } : {}),
    };

    return { payload, originalIndex };
  });

  payloads.sort((left, right) => {
    const fileCompare = left.payload.file.localeCompare(right.payload.file);
    if (fileCompare !== 0) return fileCompare;
    if (left.payload.line !== right.payload.line) return left.payload.line - right.payload.line;
    return left.originalIndex - right.originalIndex;
  });

  return payloads.map((p) => p.payload);
}
function findColumnOffset(content: string, context: SearchContext): number | undefined {
  try {
    if (context.matcher) {
      context.matcher.lastIndex = 0;
      const match = context.matcher.exec(content);
      return match ? match.index : undefined;
    }
    if (context.caseSensitive) {
      const idx = content.indexOf(context.pattern);
      return idx >= 0 ? idx : undefined;
    }
    // Case-insensitive literal search
    const idx = content.toLowerCase().indexOf(context.foldedPattern ?? '');
    return idx >= 0 ? idx : undefined;
  } catch {
    return undefined;
  }
}

function buildSearchContentOptions(
  args: SearchInput,
  signal?: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void,
): SearchContentOptions {
  const options: SearchContentOptions = {
    includeHidden: args.includeHidden,
    excludePatterns: args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS,
    filePattern: args.pattern ?? '**/*',
    caseSensitive: args.caseSensitive,
    wholeWord: args.wholeWord,
    maxResults: args.maxResults,
    isLiteral: !args.isRegex,
    respectGitignore: !args.includeIgnored,
  };

  if (args.contextLines !== undefined) options.contextLines = args.contextLines;
  if (args.contextBefore !== undefined) options.contextBefore = args.contextBefore;
  if (args.contextAfter !== undefined) options.contextAfter = args.contextAfter;
  if (args.fuzzy === true) options.fuzzy = true;
  if (args.maxDepth !== undefined) options.maxDepth = args.maxDepth;
  if (signal) options.signal = signal;
  if (onProgress) options.onProgress = onProgress;

  return options;
}

async function executeSearch(
  args: SearchInput,
  basePath: string,
  pathGuard: PathGuard,
  signal?: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void,
  fsOps?: GuardedFileSystem,
): Promise<SearchResultValue> {
  const options = buildSearchContentOptions(args, signal, onProgress);

  try {
    return await searchContent(basePath, args.searchPattern, options, pathGuard, fsOps);
  } catch (error) {
    if (error instanceof Error && /regular expression/i.test(error.message)) {
      throw new FsError({
        code: ErrorCode.INVALID_PATTERN,
        message: `Invalid regex pattern: ${formatUnknownErrorMessage(error)} (RE2: no lookahead/lookbehind/backrefs)`,
      });
    }
    throw error;
  }
}

function createSearchMatcher(args: SearchInput): RE2 | undefined {
  if (!args.isRegex) return undefined;
  try {
    const flags = args.caseSensitive ? '' : 'i';
    return new RE2(args.searchPattern, flags);
  } catch (error) {
    throw new FsError({
      code: ErrorCode.INVALID_PATTERN,
      message: `Invalid regex pattern: ${formatUnknownErrorMessage(error)} (RE2: no lookahead/lookbehind/backrefs)`,
    });
  }
}

function createSearchContext(args: SearchInput, matcher: RE2 | undefined): SearchContext {
  return {
    pattern: args.searchPattern,
    caseSensitive: args.caseSensitive,
    ...(matcher ? { matcher } : {}),
    ...(!args.isRegex && !args.caseSensitive
      ? { foldedPattern: args.searchPattern.toLowerCase() }
      : {}),
  };
}

function buildExternalizedResponse(
  fullStructured: SearchOutput,
  preview: SearchPreviewState,
  resourceStore: ResourceStore,
  searchPattern: string,
): { structured: SearchOutput; link: ReturnType<typeof putResource>['link'] } {
  const resultsJson = JSON.stringify(fullStructured, null, 2);
  const { entry, link } = putResource({
    store: resourceStore,
    name: `'${searchPattern}' matches`,
    mimeType: 'application/json',
    kind: 'text',
    content: resultsJson,
  });

  const structuredForResponse: SearchOutput = {
    ...fullStructured,
    resourceUri: entry.uri,
  };

  if (preview.needsExternalize) {
    structuredForResponse.matches = preview.visiblePayloads;
    structuredForResponse.truncated = true;
  }

  return { structured: structuredForResponse, link };
}

function getPagedPayloads(
  result: SearchResultValue,
  args: SearchInput,
  regexMatcher: RE2 | undefined,
  cursorOffset: number,
): { matchPayloads: SearchMatchPayload[]; nextCursor: string | undefined } {
  const searchContext = createSearchContext(args, regexMatcher);
  const allPayloads = buildSortedPayloads(result, searchContext);
  const matchPayloads = cursorOffset > 0 ? allPayloads.slice(cursorOffset) : allPayloads;

  const nextCursor =
    result.summary.truncated && matchPayloads.length > 0
      ? encodeOffsetCursor(cursorOffset + matchPayloads.length)
      : undefined;

  return { matchPayloads, nextCursor };
}

function finalizeSearchOutput(
  fullStructured: SearchOutput,
  preview: SearchPreviewState,
  matchPayloads: SearchMatchPayload[],
  resourceStore?: ResourceStore,
  searchPattern?: string,
): { structured: SearchOutput; link?: ReturnType<typeof putResource>['link'] } {
  if (resourceStore && matchPayloads.length > 0) {
    return buildExternalizedResponse(fullStructured, preview, resourceStore, searchPattern ?? '');
  }

  if (preview.needsExternalize) {
    fullStructured.matches = preview.visiblePayloads;
    fullStructured.truncated = true;
  }

  return { structured: fullStructured };
}

async function handleSearchContent(
  args: SearchInput,
  fsOps: GuardedFileSystem,
  pathGuard: PathGuard,
  signal?: AbortSignal,
  resourceStore?: ResourceStore,
  onProgress?: (progress: { total?: number; current: number }) => void,
): Promise<{
  structured: SearchOutput;
  link?: ReturnType<typeof putResource>['link'];
  matchCount: number;
  fileCount: number;
}> {
  const basePath = pathGuard.resolvePathOrRoot(args.path);
  const regexMatcher = createSearchMatcher(args);

  const cursorOffset = args.cursor !== undefined ? decodeOffsetCursor(args.cursor) : 0;
  const pageSize = args.maxResults;
  const fetchMax = cursorOffset + pageSize;

  const result = await executeSearch(
    { ...args, maxResults: fetchMax },
    basePath,
    pathGuard,
    signal,
    onProgress,
    fsOps,
  );

  const { matchPayloads, nextCursor } = getPagedPayloads(result, args, regexMatcher, cursorOffset);

  const fullStructured: SearchOutput = {
    ...buildSearchStructured(result.summary, matchPayloads),
  };
  if (nextCursor !== undefined) fullStructured.nextCursor = nextCursor;

  const preview = buildSearchPreviewState(matchPayloads);
  const matchCount = matchPayloads.length;
  const fileCount = new Set(matchPayloads.map((m) => m.file)).size;

  const { structured, link } = finalizeSearchOutput(
    fullStructured,
    preview,
    matchPayloads,
    resourceStore,
    args.searchPattern,
  );

  return {
    structured,
    ...(link !== undefined ? { link } : {}),
    matchCount,
    fileCount,
  };
}

export const SEARCH_CONTENT = defineTool({
  name: 'search_text',
  title: 'Search Content',
  description:
    'Search file contents for text (grep-like). Returns matching lines. ' +
    'Scope with `pattern` (e.g. `**/*.ts`) to reduce noise. ' +
    '`includeHidden=true` for dotfiles.',
  input: GrepInputSchema,
  output: GrepOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execution: { taskSupport: 'forbidden' },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  nuances: ['Inline results capped at 50 matches; full results via `resourceUri`.'],
  gotchas: [
    'RE2 dialect: no lookahead, lookbehind, or backreferences.',
    'Use `pattern` to scope to specific files; without it, scans every text file.',
    'Skips binary/oversized files silently \u2014 verify with `stat` if no matches.',
    "Patterns without '/' match by filename anywhere in the tree (e.g. *.ts finds all .ts files). Add a path prefix like src/*.ts to restrict to a subtree.",
  ],
  defaultErrorCode: ErrorCode.UNKNOWN,
  progress: (args) => ({
    label: 'Search',
    subject: truncateProgressPattern(args.searchPattern),
  }),
  progressDone: (_args, result) => ({
    detail: buildSearchMatchDetail(result.totalMatches ?? 0, result.filesMatched ?? 0),
  }),
  run: async (args, ctx) => {
    const onProgress = (params: { current: number; total?: number }): void => {
      ctx.onProgress?.({
        current: params.current,
        ...(params.total !== undefined ? { total: params.total } : {}),
      });
    };
    const { structured, link } = await handleSearchContent(
      args,
      ctx.fs,
      ctx.pathGuard,
      ctx.signal,
      ctx.resourceStore,
      onProgress,
    );
    const text =
      structured.matches.length > 0
        ? structured.matches.map((m) => `${m.file}:${String(m.line)}: ${m.content}`).join('\n')
        : `No matches for '${args.searchPattern}'`;
    if (link) {
      return { structured, text, resources: [link] };
    }
    return { structured, text };
  },
});
