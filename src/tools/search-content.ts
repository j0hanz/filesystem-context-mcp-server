import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import {
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCHABLE_FILE_SIZE,
} from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { searchContent } from '../lib/file-operations/search/engine.js';
import { createTimedAbortSignal } from '../lib/fs-helpers/abort.js';
import { withToolDiagnostics } from '../lib/observability/diagnostics.js';
import {
  SearchContentInputSchema,
  SearchContentOutputSchema,
} from '../schemas/index.js';
import {
  buildStructuredResult,
  buildTextResult,
} from './shared/search-formatting.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
  withToolErrorHandling,
} from './tool-response.js';

type SearchContentArgs = z.infer<typeof SearchContentInputSchema>;
type SearchContentStructuredResult = z.infer<typeof SearchContentOutputSchema>;

async function handleSearchContent(
  args: SearchContentArgs,
  signal?: AbortSignal
): Promise<ToolResponse<SearchContentStructuredResult>> {
  // User-provided options
  const userOptions = {
    filePattern: args.filePattern,
    excludePatterns: args.excludePatterns,
    caseSensitive: args.caseSensitive,
    maxResults: args.maxResults,
    isLiteral: args.isLiteral,
  };

  // Hardcode removed parameters with sensible defaults
  const fullOptions = {
    ...userOptions,
    contextLines: args.contextLines,
    maxFileSize: MAX_SEARCHABLE_FILE_SIZE,
    maxFilesScanned: DEFAULT_SEARCH_MAX_FILES,
    timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
    skipBinary: true,
    includeHidden: false,
    wholeWord: false,
    baseNameMatch: false,
    caseSensitiveFileMatch: true,
    signal,
  };

  const result = await searchContent(args.path, args.pattern, fullOptions);

  const structured = buildStructuredResult(result);
  structured.effectiveOptions = {
    ...userOptions,
    contextLines: args.contextLines,
  };

  return buildToolResponse(buildTextResult(result), structured);
}

const SEARCH_CONTENT_TOOL = {
  title: 'Search Content',
  description:
    'Search for text patterns within file contents using regular expressions (grep-like). ' +
    'Returns matching lines with optional context lines before and after (default 2, configurable 0-10). ' +
    'Use isLiteral=true for exact string matching. ' +
    'Filter files with filePattern glob (e.g., "**/*.ts" for TypeScript only). ' +
    'excludePatterns defaults to common dependency/build dirs (pass [] to disable).',
  inputSchema: SearchContentInputSchema,
  outputSchema: SearchContentOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

export function registerSearchContentTool(server: McpServer): void {
  const handler = (
    args: SearchContentArgs,
    extra: { signal: AbortSignal }
  ): Promise<ToolResult<SearchContentStructuredResult>> =>
    withToolDiagnostics(
      'search_content',
      () =>
        withToolErrorHandling(
          async () => {
            const { signal, cleanup } = createTimedAbortSignal(
              extra.signal,
              DEFAULT_SEARCH_TIMEOUT_MS
            );
            try {
              return await handleSearchContent(args, signal);
            } finally {
              cleanup();
            }
          },
          (error) =>
            buildToolErrorResponse(error, ErrorCode.E_UNKNOWN, args.path)
        ),
      { path: args.path }
    );

  server.registerTool('search_content', SEARCH_CONTENT_TOOL, handler);
}
