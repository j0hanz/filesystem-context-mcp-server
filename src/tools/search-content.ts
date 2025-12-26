import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode } from '../lib/errors.js';
import { searchContent } from '../lib/file-operations.js';
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
} from './tool-response.js';

type SearchContentArgs = z.infer<z.ZodObject<typeof SearchContentInputSchema>>;
type SearchContentStructuredResult = z.infer<typeof SearchContentOutputSchema>;

type SearchContentOptions = Parameters<typeof searchContent>[2];

function buildSearchContentOptions(
  args: SearchContentArgs
): SearchContentOptions {
  return {
    filePattern: args.filePattern,
    excludePatterns: args.excludePatterns,
    caseSensitive: args.caseSensitive,
    maxResults: args.maxResults,
    maxFileSize: args.maxFileSize,
    maxFilesScanned: args.maxFilesScanned,
    timeoutMs: args.timeoutMs,
    skipBinary: args.skipBinary,
    includeHidden: args.includeHidden,
    contextLines: args.contextLines,
    wholeWord: args.wholeWord,
    isLiteral: args.isLiteral,
    baseNameMatch: args.baseNameMatch,
    caseSensitiveFileMatch: args.caseSensitiveFileMatch,
  };
}

async function handleSearchContent(
  args: SearchContentArgs
): Promise<ToolResponse<SearchContentStructuredResult>> {
  const result = await searchContent(
    args.path,
    args.pattern,
    buildSearchContentOptions(args)
  );

  return buildToolResponse(
    buildTextResult(result),
    buildStructuredResult(result)
  );
}

const SEARCH_CONTENT_TOOL = {
  title: 'Search Content',
  description:
    'Search for text patterns within file contents using regular expressions (grep-like). ' +
    'Returns matching lines with optional context (contextLines parameter). ' +
    'Use isLiteral=true for exact string matching, wholeWord=true to avoid partial matches. ' +
    'Filter files with filePattern glob (e.g., "**/*.ts" for TypeScript only). ' +
    'Automatically skips binary files unless skipBinary=false.',
  inputSchema: SearchContentInputSchema,
  outputSchema: SearchContentOutputSchema.shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

const SEARCH_CONTENT_TOOL_DEPRECATED = {
  ...SEARCH_CONTENT_TOOL,
  description: `${SEARCH_CONTENT_TOOL.description} (Deprecated: use searchContent.)`,
} as const;

export function registerSearchContentTool(server: McpServer): void {
  const handler = async (
    args: SearchContentArgs
  ): Promise<ToolResult<SearchContentStructuredResult>> => {
    try {
      return await handleSearchContent(args);
    } catch (error: unknown) {
      return buildToolErrorResponse(error, ErrorCode.E_UNKNOWN, args.path);
    }
  };

  server.registerTool(
    'search_content',
    SEARCH_CONTENT_TOOL_DEPRECATED,
    handler
  );
  server.registerTool('searchContent', SEARCH_CONTENT_TOOL, handler);
}
