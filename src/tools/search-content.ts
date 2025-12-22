import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode, toRpcError } from '../lib/errors.js';
import { searchContent } from '../lib/file-operations.js';
import {
  SearchContentInputSchema,
  SearchContentOutputSchema,
} from '../schemas/index.js';
import {
  buildStructuredResult,
  buildTextResult,
} from './shared/search-formatting.js';
import { buildToolResponse, type ToolResponse } from './tool-response.js';

type SearchContentStructuredResult = z.infer<typeof SearchContentOutputSchema>;

async function handleSearchContent({
  path: searchBasePath,
  pattern,
  filePattern,
  excludePatterns,
  caseSensitive,
  maxResults,
  maxFileSize,
  maxFilesScanned,
  timeoutMs,
  skipBinary,
  includeHidden,
  contextLines,
  wholeWord,
  isLiteral,
  baseNameMatch,
  caseSensitiveFileMatch,
}: {
  path: string;
  pattern: string;
  filePattern?: string;
  excludePatterns?: string[];
  caseSensitive?: boolean;
  maxResults?: number;
  maxFileSize?: number;
  maxFilesScanned?: number;
  timeoutMs?: number;
  skipBinary?: boolean;
  includeHidden?: boolean;
  contextLines?: number;
  wholeWord?: boolean;
  isLiteral?: boolean;
  baseNameMatch?: boolean;
  caseSensitiveFileMatch?: boolean;
}): Promise<ToolResponse<SearchContentStructuredResult>> {
  const result = await searchContent(searchBasePath, pattern, {
    filePattern,
    excludePatterns,
    caseSensitive,
    maxResults,
    maxFileSize,
    maxFilesScanned,
    timeoutMs,
    skipBinary,
    includeHidden,
    contextLines,
    wholeWord,
    isLiteral,
    baseNameMatch,
    caseSensitiveFileMatch,
  });

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
  outputSchema: SearchContentOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

export function registerSearchContentTool(server: McpServer): void {
  server.registerTool('search_content', SEARCH_CONTENT_TOOL, async (args) => {
    try {
      return await handleSearchContent(args);
    } catch (error) {
      throw toRpcError(error, ErrorCode.E_UNKNOWN, args.path);
    }
  });
}
