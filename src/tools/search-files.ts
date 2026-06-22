import * as z from 'zod/v4';

import { ErrorCode } from '../core/errors.js';
import { formatCount, truncateProgressPattern } from '../core/fmt.js';
import { DEFAULT_EXCLUDE_PATTERNS } from '../core/fs.js';
import { PathFormatter } from '../core/path-formatter.js';
import type { PathGuard } from '../core/path.js';
import { decodeOffsetCursor, encodeOffsetCursor } from '../core/path.js';
import { searchFiles } from '../core/search/index.js';
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
  IsoDateTime,
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
    .enum(['name', 'size', 'modified', 'path'])
    .optional()
    .default('path')
    .describe(
      'Sort order: path = full path (default), name = basename only, size = bytes descending, modified = newest first',
    ),
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
      path: PathFormatter.relative(basePath, entry.path),
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
