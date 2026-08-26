import * as z from 'zod/v4';

import { SearchStoppedReasonSchema } from '../core/concurrency.js';
import { createFirstPage, readNextPage } from '../core/cursor.js';
import { ErrorCode } from '../core/errors.js';
import { formatCount, truncateProgressPattern } from '../core/fmt.js';
import { DEFAULT_EXCLUDE_PATTERNS } from '../core/glob.js';
import { toPosixRelative } from '../core/path.js';
import {
  CursorSchema,
  includeHiddenField,
  includeIgnoredField,
  maxDepthField,
  NextCursorSchema,
  NonNegInt,
  OptionalPath,
  SafeGlobPattern,
} from '../core/schema.js';
import { searchFiles } from '../core/search.js';
import { putJsonResource } from '../core/store.js';
import {
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_RESULTS,
} from '../core/util.js';
import { defineTool, type ToolCtx } from './define.js';

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
    .enum(['name', 'path'])
    .optional()
    .default('path')
    .describe('Sort order: path = full path (default), name = basename only'),
  maxDepth: maxDepthField(),
  cursor: CursorSchema,
});

const SearchFilesOutputSchema = z.strictObject({
  root: z.string().describe('Resolved base directory used as the search root'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('File path relative to the search root'),
      }),
    )
    .describe('Matched files ordered by sortBy'),
  totalMatches: NonNegInt.optional().describe('Total number of matching files found'),
  filesScanned: NonNegInt.optional().describe('Total number of files examined during the search'),
  skippedInaccessible: NonNegInt.optional().describe(
    'Files skipped due to permission or access errors',
  ),
  stoppedReason: SearchStoppedReasonSchema.describe(
    'Why the search ended early: maxResults = result cap reached, timeout = time limit hit or the request was cancelled. Absent when the scan ran to completion.',
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
  displayResults: readonly { path: string }[],
): NonNullable<z.infer<typeof SearchFilesOutputSchema>['results']> {
  const relativeResults: NonNullable<z.infer<typeof SearchFilesOutputSchema>['results']> = [];
  for (const entry of displayResults) {
    relativeResults.push({
      path: toPosixRelative(basePath, entry.path),
    });
  }
  return relativeResults;
}

type SearchFileResult = NonNullable<z.infer<typeof SearchFilesOutputSchema>['results']>[number];

interface SearchFilesPageMetadata {
  readonly root: string;
  readonly totalMatches: number;
  readonly filesScanned: number;
  readonly skippedInaccessible?: number;
  readonly stoppedReason?: z.infer<typeof SearchFilesOutputSchema>['stoppedReason'];
  readonly resourceUri?: string;
}

function searchFilesQueryKey(
  args: z.infer<typeof SearchFilesInputSchema>,
  basePath: string,
): string {
  return JSON.stringify({
    method: 'find_files',
    path: basePath,
    pattern: args.pattern,
    includeIgnored: args.includeIgnored,
    includeHidden: args.includeHidden,
    sortBy: args.sortBy,
    maxDepth: args.maxDepth,
  });
}

function searchFilesOutput(
  results: readonly SearchFileResult[],
  metadata: SearchFilesPageMetadata,
  nextCursor: string | undefined,
): z.infer<typeof SearchFilesOutputSchema> {
  return {
    root: metadata.root,
    results: [...results],
    totalMatches: metadata.totalMatches,
    filesScanned: metadata.filesScanned,
    ...(metadata.skippedInaccessible ? { skippedInaccessible: metadata.skippedInaccessible } : {}),
    ...(metadata.stoppedReason !== undefined ? { stoppedReason: metadata.stoppedReason } : {}),
    ...(metadata.resourceUri ? { resourceUri: metadata.resourceUri } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

async function handleSearchFiles(
  args: z.infer<typeof SearchFilesInputSchema>,
  ctx: ToolCtx,
): Promise<{
  structured: z.infer<typeof SearchFilesOutputSchema>;
  link?: ReturnType<typeof putJsonResource>['link'];
}> {
  const requestedBasePath = ctx.fs.pathGuard.resolvePathOrRoot(args.path);
  const queryKey = searchFilesQueryKey(args, requestedBasePath);
  if (args.cursor !== undefined) {
    const paged = readNextPage<SearchFileResult, SearchFilesPageMetadata>({
      store: ctx.pageStore,
      queryKey,
      cursor: args.cursor,
      pageSize: args.maxResults,
    });
    return {
      structured: searchFilesOutput(paged.page, paged.metadata, paged.nextCursor),
    };
  }

  const basePath = await ctx.fs.pathGuard.validateExistingDirectory(requestedBasePath);
  const excludePatterns = args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS;
  const searchOptions: Parameters<typeof searchFiles>[3] = {
    maxResults: MAX_SEARCH_RESULTS,
    includeHidden: args.includeHidden,
    sortBy: args.sortBy,
    respectGitignore: !args.includeIgnored,
    ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
    signal: ctx.signal,
  };
  const result = await searchFiles(
    basePath,
    args.pattern,
    excludePatterns,
    searchOptions,
    ctx.fs.pathGuard,
  );
  const relativeResults = buildRelativeResults(result.basePath, result.results);

  // Store the full result set so a caller can fetch all matching files by URI
  // when the response is incomplete: `nextCursor` covers the multi-page case,
  // and `summary.truncated` covers a single page that already hit the hard result
  // cap (no nextCursor, but more matches exist beyond the cap).
  let resourceUri: string | undefined;
  let link: ReturnType<typeof putJsonResource>['link'] | undefined;
  if (
    ctx.resourceStore !== undefined &&
    (relativeResults.length > args.maxResults || result.summary.truncated)
  ) {
    const stored = putJsonResource(ctx.resourceStore, `${args.pattern} files`, relativeResults);
    resourceUri = stored.entry.uri;
    link = stored.link;
  }

  const metadata: SearchFilesPageMetadata = {
    root: result.basePath,
    totalMatches: result.summary.matched,
    filesScanned: result.summary.filesScanned,
    ...(result.summary.skippedInaccessible
      ? { skippedInaccessible: result.summary.skippedInaccessible }
      : {}),
    ...(result.summary.stoppedReason !== undefined && result.summary.stoppedReason !== 'maxFiles'
      ? { stoppedReason: result.summary.stoppedReason }
      : {}),
    ...(resourceUri ? { resourceUri } : {}),
  };
  const paged = createFirstPage<SearchFileResult, SearchFilesPageMetadata>({
    store: ctx.pageStore,
    queryKey,
    items: relativeResults,
    metadata,
    pageSize: args.maxResults,
  });
  return {
    structured: searchFilesOutput(paged.page, metadata, paged.nextCursor),
    ...(link !== undefined ? { link } : {}),
  };
}

export const SEARCH_FILES = defineTool({
  name: 'find_files',
  title: 'Find Files',
  description:
    'Find files matching a glob pattern. Returns matched paths with optional metadata. ' +
    'Pagination cursors reference a query-bound snapshot that expires after 60 seconds. ' +
    'For content search use search_text; for bulk regex replacements use replace_text with the same glob.',
  input: SearchFilesInputSchema,
  output: SearchFilesOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.UNKNOWN,
  progress: (args) => ({
    label: 'Find',
    subject: truncateProgressPattern(args.pattern),
  }),
  progressDone: (_args, result) => ({
    detail: formatCount(result.totalMatches ?? 0, 'match', 'matches'),
  }),
  accessPaths: (args) => (args.path ? [args.path] : []),
  run: async (args, ctx) => {
    const { structured, link } = await handleSearchFiles(args, ctx);
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
