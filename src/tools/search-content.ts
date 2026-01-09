import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import {
  DEFAULT_EXCLUDE_PATTERNS,
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
import { resolvePathOrRoot } from './shared/resolve-path.js';
import {
  buildStructuredResult,
  buildTextResult,
} from './shared/search-formatting.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  withToolErrorHandling,
} from './tool-response.js';

type SearchContentArgs = z.infer<typeof SearchContentInputSchema>;
type SearchContentStructuredResult = z.infer<typeof SearchContentOutputSchema>;
type SearchOptions = Parameters<typeof searchContent>[2];

function resolveExcludePatterns(args: SearchContentArgs): readonly string[] {
  if (args.excludePatterns) return args.excludePatterns;
  return args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS;
}

function resolveMaxFileSize(args: SearchContentArgs): number {
  if (typeof args.maxFileSize !== 'number') {
    return MAX_SEARCHABLE_FILE_SIZE;
  }
  return Math.min(args.maxFileSize, MAX_SEARCHABLE_FILE_SIZE);
}

function buildSearchOptionsBase(args: SearchContentArgs): SearchOptions {
  const includeHidden = args.includeHidden || args.includeIgnored;
  return {
    filePattern: args.filePattern,
    excludePatterns: resolveExcludePatterns(args),
    caseSensitive: args.caseSensitive,
    isLiteral: args.isLiteral,
    contextLines: args.contextLines,
    maxResults: args.maxResults,
    maxFileSize: resolveMaxFileSize(args),
    maxFilesScanned: args.maxFilesScanned,
    timeoutMs: args.timeoutMs,
    skipBinary: args.skipBinary,
    includeHidden,
    wholeWord: args.wholeWord,
    baseNameMatch: args.baseNameMatch,
    caseSensitiveFileMatch: args.caseSensitiveFileMatch,
  };
}

function buildSearchOptions(
  args: SearchContentArgs,
  signal?: AbortSignal
): SearchOptions {
  const options = buildSearchOptionsBase(args);
  if (signal) return { ...options, signal };
  return options;
}

async function handleSearchContent(
  args: SearchContentArgs,
  signal?: AbortSignal
): Promise<ToolResponse<SearchContentStructuredResult>> {
  const basePath = resolvePathOrRoot(args.path);
  const fullOptions = buildSearchOptions(args, signal);
  const result = await searchContent(basePath, args.pattern, fullOptions);
  return buildToolResponse(
    buildTextResult(result),
    buildStructuredResult(result)
  );
}

const SEARCH_CONTENT_TOOL = {
  title: 'Search Content',
  description:
    'Search for text within file contents (grep-like). ' +
    'Returns matching lines. ' +
    'Use includeIgnored=true to search in node_modules/dist for debugging.',
  inputSchema: SearchContentInputSchema,
  outputSchema: SearchContentOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

export function registerSearchContentTool(server: McpServer): void {
  server.registerTool('grep', SEARCH_CONTENT_TOOL, (args, extra) =>
    withToolDiagnostics(
      'grep',
      () =>
        withToolErrorHandling(
          async () => {
            const { signal, cleanup } = createTimedAbortSignal(
              extra.signal,
              args.timeoutMs
            );
            try {
              return await handleSearchContent(args, signal);
            } finally {
              cleanup();
            }
          },
          (error) =>
            buildToolErrorResponse(error, ErrorCode.E_UNKNOWN, args.path ?? '.')
        ),
      { path: args.path ?? '.' }
    )
  );
}
