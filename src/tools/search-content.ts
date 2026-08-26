import * as z from 'zod/v4';

import { SearchStoppedReasonSchema } from '../core/concurrency.js';
import { closePage, openPage } from '../core/cursor.js';
import { ErrorCode } from '../core/errors.js';
import { formatCount, truncateProgressPattern } from '../core/fmt.js';
import { DEFAULT_EXCLUDE_PATTERNS } from '../core/glob.js';
import { toPosixRelative } from '../core/path.js';
import { escapeRegexLiteral } from '../core/primitives.js';
import {
  CursorSchema,
  defaultFalseBoolean,
  includeHiddenField,
  includeIgnoredField,
  isBlank,
  maxDepthField,
  NextCursorSchema,
  NonNegInt,
  OptionalPath,
  PositiveInt,
  SafeGlobPattern,
} from '../core/schema.js';
import type { Regex, SearchContentOptions } from '../core/search.js';
import { compileRegex, freeRegex, searchContent } from '../core/search.js';
import type { ResourceStore } from '../core/store.js';
import { putJsonResource } from '../core/store.js';
import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_RESULTS,
  parseEnvInt,
} from '../core/util.js';
import { defineTool, type ToolCtx } from './define.js';

/**
 * Configuration constants for the Search Content tool.
 */
const CONFIG = {
  MAX_INLINE_MATCHES: parseEnvInt('FS_CONTEXT_MAX_INLINE_MATCHES', 50, 1, 10_000),
} as const;

// Type Definitions
type SearchInput = z.infer<typeof GrepInputSchema>;
type SearchOutput = z.infer<typeof GrepOutputSchema>;
type SearchMatchPayload = NonNullable<SearchOutput['matches']>[number];
type SearchResultValue = Awaited<ReturnType<typeof searchContent>>;
type SearchSummary = SearchResultValue['summary'];

interface SearchPreviewState {
  needsExternalize: boolean;
  visiblePayloads: SearchMatchPayload[];
}

interface SearchContext {
  pattern: string;
  matcher?: Regex;
  caseSensitive: boolean;
}

function buildStructuredSummaryFields(summary: SearchSummary): Partial<SearchOutput> {
  return {
    ...(summary.filesMatched ? { filesMatched: summary.filesMatched } : {}),
    ...(summary.truncated ? { truncated: true } : {}),
    // `maxFiles` is unreachable here — this scan calls only hitMaxResults and
    // hitAbort — so it is excluded rather than published as a value no response
    // can carry. The shared tracker type is wider than this one caller.
    ...(summary.stoppedReason !== undefined && summary.stoppedReason !== 'maxFiles'
      ? { stoppedReason: summary.stoppedReason }
      : {}),
    ...(summary.skippedInaccessible ? { skippedInaccessible: summary.skippedInaccessible } : {}),
    ...(summary.skippedTooLarge ? { skippedTooLarge: summary.skippedTooLarge } : {}),
  };
}

function buildSearchPreviewState(payloads: SearchMatchPayload[]): SearchPreviewState {
  const needsExternalize = payloads.length > CONFIG.MAX_INLINE_MATCHES;
  const visibleCount = needsExternalize ? CONFIG.MAX_INLINE_MATCHES : payloads.length;

  return {
    needsExternalize,
    visiblePayloads: payloads.slice(0, visibleCount),
  };
}

const GrepInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'File to search, or directory to search under (default: the whole first allowed root)',
  ),
  pattern: SafeGlobPattern.optional().describe(
    'Glob to restrict search to specific file types (e.g. **/*.ts); default: all text files',
  ),
  searchPattern: z
    .string()
    .min(1)
    .max(10000)
    .refine((val) => !isBlank(val), {
      message: 'searchPattern cannot be empty or whitespace-only',
    })
    .describe(
      'Exact literal text or RE2 regex pattern to search for in file contents. When isRegex=true, uses RE2 syntax (no lookahead, lookbehind, or backreferences). Cannot be empty or whitespace-only.',
    )
    .meta({ examples: ['TODO', 'function\\s+(\\w+)', 'import.*from'] }),
  isRegex: defaultFalseBoolean('Treat searchPattern as a regex (default: literal text match)'),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  caseSensitive: defaultFalseBoolean('Enable case-sensitive matching (default: case-insensitive)'),
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
  matches: z
    .array(
      z.strictObject({
        file: z.string().describe('File path relative to the search root'),
        line: PositiveInt.describe('1-indexed line number of the match'),
        column: NonNegInt.optional().describe('0-indexed column offset of the match start'),
        content: z.string().describe('Full text of the matching line'),
        matchCount: NonNegInt.optional().describe('Number of pattern occurrences on this line'),
      }),
    )
    .describe('Flat list of matches sorted by file path then line number'),
  totalMatches: NonNegInt.optional().describe(
    "Total matching lines, one per entry in matches (not per occurrence); see that entry's matchCount for occurrences on a line.",
  ),
  filesMatched: NonNegInt.optional().describe('Number of files containing at least one match'),
  filesScanned: NonNegInt.optional().describe('Total number of files examined'),
  skippedInaccessible: NonNegInt.optional().describe(
    'Files skipped unread due to permission or access errors',
  ),
  skippedTooLarge: NonNegInt.optional().describe(
    'Files skipped unread because they exceed the text-file size limit; raise the limit or narrow pattern if a match was expected in one',
  ),
  truncated: z
    .boolean()
    .optional()
    .describe('True when the match list was cut due to maxResults or timeout'),
  stoppedReason: SearchStoppedReasonSchema.describe(
    'Why the search ended early: maxResults = result cap reached, timeout = time limit hit or the request was cancelled. Absent when the scan ran to completion.',
  ),
  resourceUri: z
    .string()
    .optional()
    .describe(
      'URI to the full match list in the resource store (present when matches exceed the inline limit)',
    ),
  nextCursor: NextCursorSchema,
});

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
    matches,
    totalMatches: summary.matchingLines,
    filesScanned: summary.filesScanned,
    ...buildStructuredSummaryFields(summary),
  };
}

function findColumnOffset(content: string, context: SearchContext): number | undefined {
  if (context.matcher) {
    context.matcher.lastIndex = 0;
    const match = context.matcher.exec(content);
    return match ? match.index : undefined;
  }
  if (context.caseSensitive) {
    const idx = content.indexOf(context.pattern);
    return idx >= 0 ? idx : undefined;
  }
  return undefined;
}

function buildSortedPayloads(
  result: SearchResultValue,
  context: SearchContext,
): SearchMatchPayload[] {
  const relativeByFile = new Map<string, string>();

  const getRelativeFile = (file: string): string => {
    const cached = relativeByFile.get(file);
    if (cached !== undefined) return cached;

    const rel = toPosixRelative(result.basePath, file);
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

function buildSearchContentOptions(args: SearchInput, signal?: AbortSignal): SearchContentOptions {
  return {
    includeHidden: args.includeHidden,
    excludePatterns: args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS,
    filePattern: args.pattern ?? '**/*',
    caseSensitive: args.caseSensitive,
    isRegex: args.isRegex,
    maxResults: args.maxResults,
    respectGitignore: !args.includeIgnored,
    ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
    ...(signal ? { signal } : {}),
  };
}

function createSearchMatcher(args: SearchInput): Regex | undefined {
  if (args.isRegex) {
    return compileRegex(args.searchPattern, { caseSensitive: args.caseSensitive });
  }
  if (!args.caseSensitive) {
    return compileRegex(escapeRegexLiteral(args.searchPattern), { caseSensitive: false });
  }
  return undefined;
}

function createSearchContext(args: SearchInput, matcher: Regex | undefined): SearchContext {
  return {
    pattern: args.searchPattern,
    caseSensitive: args.caseSensitive,
    ...(matcher ? { matcher } : {}),
  };
}

function buildExternalizedResponse(
  fullStructured: SearchOutput,
  preview: SearchPreviewState,
  resourceStore: ResourceStore,
  searchPattern: string,
): { structured: SearchOutput; link: ReturnType<typeof putJsonResource>['link'] } {
  const { entry, link } = putJsonResource(
    resourceStore,
    `'${searchPattern}' matches`,
    fullStructured,
  );

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
  // Sort the full capped set before slicing: every page must sort the same
  // universe (see openPage), so the page window is bounded by pageSize here.
  const sorted = buildSortedPayloads(result, searchContext);
  const matchPayloads = sorted.slice(cursorOffset, cursorOffset + args.maxResults);
  const nextCursor = closePage({
    total: sorted.length,
    offset: cursorOffset,
    pageCount: matchPayloads.length,
  });

  return { matchPayloads, nextCursor };
}

function finalizeSearchOutput(
  fullStructured: SearchOutput,
  preview: SearchPreviewState,
  resourceStore?: ResourceStore,
  searchPattern?: string,
): { structured: SearchOutput; link?: ReturnType<typeof putJsonResource>['link'] } {
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
  ctx: ToolCtx,
): Promise<{
  structured: SearchOutput;
  link?: ReturnType<typeof putJsonResource>['link'];
}> {
  const basePath = await ctx.fs.pathGuard.validateExistingDirectory(
    ctx.fs.pathGuard.resolvePathOrRoot(args.path),
  );
  const regexMatcher = createSearchMatcher(args);

  const { offset: cursorOffset, fetchMax } = openPage({
    cursor: args.cursor,
    max: MAX_SEARCH_RESULTS,
  });

  const result = await searchContent(
    basePath,
    args.searchPattern,
    buildSearchContentOptions({ ...args, maxResults: fetchMax }, ctx.signal),
    ctx.fs.pathGuard,
  );

  // regexMatcher holds wasm memory re2-wasm never reclaims on its own.
  let matchPayloads: SearchMatchPayload[];
  let nextCursor: string | undefined;
  try {
    ({ matchPayloads, nextCursor } = getPagedPayloads(result, args, regexMatcher, cursorOffset));
  } finally {
    freeRegex(regexMatcher);
  }

  const fullStructured: SearchOutput = {
    ...buildSearchStructured(result.summary, matchPayloads),
  };
  if (nextCursor !== undefined) fullStructured.nextCursor = nextCursor;

  const preview = buildSearchPreviewState(matchPayloads);

  const { structured, link } = finalizeSearchOutput(
    fullStructured,
    preview,
    ctx.resourceStore,
    args.searchPattern,
  );

  return {
    structured,
    ...(link !== undefined ? { link } : {}),
  };
}

export const SEARCH_CONTENT = defineTool({
  name: 'search_text',
  title: 'Search Content',
  description:
    'Search file contents by text or regex (grep-style). Returns matching lines with file path and line number. ' +
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
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.UNKNOWN,
  progress: (args) => ({
    label: 'Search',
    subject: truncateProgressPattern(args.searchPattern),
  }),
  progressDone: (_args, result) => ({
    detail: buildSearchMatchDetail(result.totalMatches ?? 0, result.filesMatched ?? 0),
  }),
  accessPaths: (args) => (args.path ? [args.path] : []),
  run: async (args, ctx) => {
    const { structured, link } = await handleSearchContent(args, ctx);
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
