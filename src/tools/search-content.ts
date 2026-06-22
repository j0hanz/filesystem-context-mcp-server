import { relative } from 'node:path';

import * as z from 'zod/v4';

import { ErrorCode } from '../core/errors.js';
import { formatCount, truncateProgressPattern } from '../core/fmt.js';
import type { GuardedFileSystem } from '../core/fs.js';
import { DEFAULT_EXCLUDE_PATTERNS } from '../core/fs.js';
import type { PathGuard } from '../core/path.js';
import { decodeOffsetCursor, encodeOffsetCursor } from '../core/path.js';
import {
  compileRegex,
  type Regex,
  searchContent,
  type SearchContentOptions,
  SearchWorkerPool,
} from '../core/search/index.js';
import type { ResourceStore } from '../core/store.js';
import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_RESULTS,
  parseEnvInt,
} from '../core/util.js';
import {
  CursorSchema,
  defaultFalseBoolean,
  includeHiddenField,
  includeIgnoredField,
  maxDepthField,
  NextCursorSchema,
  NonNegInt,
  OptionalPath,
  PositiveInt,
  SafeGlobPattern,
} from '../schema.js';
import { putResource } from './_helpers.js';
import { defineTool } from './define.js';

// ---------------------------------------------------------------------------
// Re-export SearchWorkerPool for compatibility
// ---------------------------------------------------------------------------
export { SearchWorkerPool };

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
  matcher?: Regex;
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
  pattern: SafeGlobPattern.optional().describe(
    'Glob to restrict search to specific file types (e.g. **/*.ts); default: all text files',
  ),
  searchPattern: z
    .string()
    .min(1)
    .max(10000)
    .refine((val) => val.trim().length > 0, {
      message: 'searchPattern cannot be empty or whitespace-only',
    })
    .describe(
      'Exact literal text or RE2 regex pattern to search for in file contents. When isRegex=true, uses RE2 syntax (no lookahead, lookbehind, or backreferences are supported). Cannot be empty or whitespace-only.',
    )
    .meta({ examples: ['TODO', 'function\\s+(\\w+)', 'import.*from'] }),
  isRegex: defaultFalseBoolean('Treat searchPattern as a RE2 regex (default: literal text match)'),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  caseSensitive: defaultFalseBoolean('Enable case-sensitive matching (default: case-insensitive)'),
  wholeWord: defaultFalseBoolean('Match whole words only (word boundary anchoring)'),
  contextLines: z
    .int32()
    .min(0)
    .max(20)
    .optional()
    .describe(
      'Symmetric context: N lines before AND after each match. Overridden per-side by contextBefore/contextAfter.',
    ),
  contextBefore: z
    .int32()
    .min(0)
    .max(20)
    .optional()
    .describe(
      'Lines of context to include before each match (overrides the before half of contextLines)',
    ),
  contextAfter: z
    .int32()
    .min(0)
    .max(20)
    .optional()
    .describe(
      'Lines of context to include after each match (overrides the after half of contextLines)',
    ),
  fuzzy: z
    .boolean()
    .optional()
    .describe(
      'Enable approximate (fuzzy) matching using Levenshtein distance (\u226425% character difference). Incompatible with isRegex. Requires searchPattern of at least 4 characters.',
    ),

  maxResults: z
    .uint32()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .default(DEFAULT_SEARCH_CONTENT_RESULTS)
    .describe('Maximum number of matching lines to return per page'),
  maxDepth: maxDepthField(),
  cursor: CursorSchema,
});

const GrepOutputSchema = z.strictObject({
  ok: z
    .literal(true)
    .describe('Always true; errors are surfaced in stoppedReason or per-file skip counts'),
  matches: z
    .array(
      z.strictObject({
        file: z.string().describe('File path relative to the search root'),
        line: PositiveInt.describe('1-indexed line number of the match'),
        column: NonNegInt.optional().describe('0-indexed column offset of the match start'),
        content: z.string().describe('Full text of the matching line'),
        matchCount: NonNegInt.optional().describe('Number of pattern occurrences on this line'),
        contextBefore: z
          .array(z.string())
          .optional()
          .describe('Lines immediately before the match (contextBefore or contextLines)'),
        contextAfter: z
          .array(z.string())
          .optional()
          .describe('Lines immediately after the match (contextAfter or contextLines)'),
      }),
    )
    .describe('Flat list of matches sorted by file path then line number'),
  totalMatches: NonNegInt.optional().describe('Total number of matching lines found'),
  filesMatched: NonNegInt.optional().describe('Number of files containing at least one match'),
  filesScanned: NonNegInt.optional().describe('Total number of files examined'),
  skippedTooLarge: NonNegInt.optional().describe(
    'Files skipped because they exceeded the size limit',
  ),
  skippedBinary: NonNegInt.optional().describe(
    'Files skipped because they were detected as binary',
  ),
  skippedInaccessible: NonNegInt.optional().describe(
    'Files skipped due to permission or access errors',
  ),
  truncated: z
    .boolean()
    .optional()
    .describe('True when the match list was cut due to maxResults or timeout'),
  stoppedReason: z
    .enum(['maxResults', 'maxFiles', 'timeout'])
    .optional()
    .describe(
      'Why the search ended early: maxResults = match cap reached, maxFiles = scan cap reached, timeout = time limit hit',
    ),
  resourceUri: z
    .string()
    .optional()
    .describe(
      'URI to the full match list in the resource store (present when matches exceed the inline limit)',
    ),
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
  return searchContent(basePath, args.searchPattern, options, pathGuard, fsOps);
}

function createSearchMatcher(args: SearchInput): Regex | undefined {
  if (!args.isRegex) return undefined;
  return compileRegex(args.searchPattern, { caseSensitive: args.caseSensitive });
}

function createSearchContext(args: SearchInput, matcher: Regex | undefined): SearchContext {
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
  regexMatcher: Regex | undefined,
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
  resourceStore?: ResourceStore,
  searchPattern?: string,
): { structured: SearchOutput; link?: ReturnType<typeof putResource>['link'] } {
  if (resourceStore && preview.needsExternalize) {
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
    'Search file contents by text or regex (grep-style). Returns matching lines with file path, line number, and optional context. ' +
    'Scope to specific file types with pattern (e.g. **/*.ts). ' +
    'Set includeHidden=true to include dotfiles. Use find_files to search by filename instead.',
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
  nuances: [
    'Inline results are capped at 50 matches; the full list is stored at resourceUri when exceeded.',
  ],
  gotchas: [
    'isRegex=true uses RE2 syntax: lookahead, lookbehind, and backreferences are not supported.',
    'Without pattern, every text file is scanned; always set pattern to a specific glob to limit scope.',
    'Binary and oversized files are silently skipped; use stat to verify a file is readable if you expect matches.',
    'File patterns without a slash (e.g. *.ts) match by basename anywhere in the tree. Add a path prefix (e.g. src/*.ts) to restrict to a subtree.',
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
