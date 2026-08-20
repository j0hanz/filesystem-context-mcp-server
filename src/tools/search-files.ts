import * as z from 'zod/v4';

import { decodeOffsetCursor, encodeOffsetCursor } from '../core/cursor.js';
import { ErrorCode } from '../core/errors.js';
import { formatCount, truncateProgressPattern } from '../core/fmt.js';
import { DEFAULT_EXCLUDE_PATTERNS } from '../core/glob.js';
import { type PathGuard, toPosixRelative } from '../core/path.js';
import { searchFiles } from '../core/search/engine.js';
import type { ResourceStore } from '../core/store.js';
import {
  assignDefined,
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_RESULTS,
} from '../core/util.js';
import {
  CursorSchema,
  includeHiddenField,
  includeIgnoredField,
  maxDepthField,
  NextCursorSchema,
  NonNegInt,
  OptionalPath,
  SafeGlobPattern,
} from '../schema.js';
import { putResource } from './_helpers.js';
import { defineTool } from './define.js';

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
  ok: z.literal(true).describe('Always true; call succeeded'),
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
  stoppedReason: z
    .enum(['maxResults', 'timeout'])
    .optional()
    .describe(
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
    stoppedReason?: 'timeout' | 'maxResults';
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
  resourceStore?: ResourceStore,
): Promise<{
  structured: z.infer<typeof SearchFilesOutputSchema>;
  link?: ReturnType<typeof putResource>['link'];
  count: number;
}> {
  const basePath = await pathGuard.validateExistingDirectory(
    pathGuard.resolvePathOrRoot(args.path),
  );
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
  assignDefined(searchOptions, { maxDepth: args.maxDepth, signal });
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

  // If results were paginated, store the full list in the resource store
  if (resourceStore !== undefined && result.summary.truncated) {
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
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.UNKNOWN,
  progress: (args) => ({
    label: 'Find',
    subject: truncateProgressPattern(args.pattern),
  }),
  progressDone: (_args, result) => ({
    detail: formatCount(result.totalMatches ?? 0, 'match', 'matches'),
  }),
  run: async (args, ctx) => {
    const { structured, link } = await handleSearchFiles(
      args,
      ctx.pathGuard,
      ctx.signal,
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
