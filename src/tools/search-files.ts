import * as pathModule from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import {
  formatBytes,
  formatOperationSummary,
  joinLines,
} from '../config/formatting.js';
import { ErrorCode } from '../lib/errors.js';
import { searchFiles } from '../lib/file-operations.js';
import {
  SearchFilesInputSchema,
  SearchFilesOutputSchema,
} from '../schemas/index.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
  withToolErrorHandling,
} from './tool-response.js';

type SearchFilesArgs = z.infer<z.ZodObject<typeof SearchFilesInputSchema>>;
type SearchFilesStructuredResult = z.infer<typeof SearchFilesOutputSchema>;

function formatSearchResults(
  results: Awaited<ReturnType<typeof searchFiles>>['results']
): string {
  if (results.length === 0) return 'No matches';

  const lines = results.map((result) => {
    const tag = result.type === 'directory' ? '[DIR]' : '[FILE]';
    const size =
      result.size !== undefined ? ` (${formatBytes(result.size)})` : '';
    return `${tag} ${result.path}${size}`;
  });

  return joinLines([`Found ${results.length}:`, ...lines]);
}

function buildStructuredResult(
  result: Awaited<ReturnType<typeof searchFiles>>
): SearchFilesStructuredResult {
  const { basePath, pattern, results, summary } = result;
  return {
    ok: true,
    basePath,
    pattern,
    results: results.map((r) => ({
      path: pathModule.relative(basePath, r.path),
      type: r.type === 'directory' ? 'other' : r.type,
      size: r.size,
      modified: r.modified?.toISOString(),
    })),
    summary: {
      matched: summary.matched,
      truncated: summary.truncated,
      skippedInaccessible: summary.skippedInaccessible,
      filesScanned: summary.filesScanned,
      stoppedReason: summary.stoppedReason,
    },
  };
}

function buildTruncationInfo(result: Awaited<ReturnType<typeof searchFiles>>): {
  truncatedReason?: string;
  tip?: string;
} {
  if (!result.summary.truncated) return {};
  if (result.summary.stoppedReason === 'timeout') {
    return {
      truncatedReason: 'search timed out',
      tip: 'Increase timeoutMs, use a more specific pattern, or add excludePatterns to narrow scope.',
    };
  }
  if (result.summary.stoppedReason === 'maxResults') {
    return {
      truncatedReason: `reached max results limit (${result.summary.matched} returned)`,
    };
  }
  if (result.summary.stoppedReason === 'maxFiles') {
    return {
      truncatedReason: `reached max files limit (${result.summary.filesScanned} scanned)`,
    };
  }
  return {};
}

function buildTextResult(
  result: Awaited<ReturnType<typeof searchFiles>>
): string {
  const { summary, results } = result;
  const { truncatedReason, tip } = buildTruncationInfo(result);
  let textOutput = formatSearchResults(results);
  if (results.length === 0) {
    textOutput +=
      '\n(Try a broader pattern, remove excludePatterns, or set includeHidden=true if searching dotfiles.)';
  }
  textOutput += formatOperationSummary({
    truncated: summary.truncated,
    truncatedReason,
    tip:
      tip ??
      (summary.truncated
        ? 'Increase maxResults, use more specific pattern, or add excludePatterns to narrow scope.'
        : undefined),
    skippedInaccessible: summary.skippedInaccessible,
  });
  return textOutput;
}

async function handleSearchFiles(
  {
    path: searchBasePath,
    pattern,
    excludePatterns,
    maxResults,
    sortBy,
    maxDepth,
    maxFilesScanned,
    timeoutMs,
    baseNameMatch,
    skipSymlinks,
    includeHidden,
  }: {
    path: string;
    pattern: string;
    excludePatterns?: string[];
    maxResults?: number;
    sortBy?: 'name' | 'size' | 'modified' | 'path';
    maxDepth?: number;
    maxFilesScanned?: number;
    timeoutMs?: number;
    baseNameMatch?: boolean;
    skipSymlinks?: boolean;
    includeHidden?: boolean;
  },
  signal?: AbortSignal
): Promise<ToolResponse<SearchFilesStructuredResult>> {
  const result = await searchFiles(searchBasePath, pattern, excludePatterns, {
    maxResults,
    sortBy,
    maxDepth,
    maxFilesScanned,
    timeoutMs,
    baseNameMatch,
    skipSymlinks,
    includeHidden,
    signal,
  });
  return buildToolResponse(
    buildTextResult(result),
    buildStructuredResult(result)
  );
}

const SEARCH_FILES_TOOL = {
  title: 'Search Files',
  description:
    'Find files (not directories) matching a glob pattern within a directory tree. ' +
    'Pattern examples: "**/*.ts" (all TypeScript files), "src/**/*.{js,jsx}" (JS/JSX in src), ' +
    '"**/test/**" (all test directories). Returns paths, types, sizes, and modification dates. ' +
    'excludePatterns defaults to common dependency/build dirs (pass [] to disable). ' +
    'Symlink traversal is disabled (skipSymlinks must remain true).',
  inputSchema: SearchFilesInputSchema,
  outputSchema: SearchFilesOutputSchema.shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

export function registerSearchFilesTool(server: McpServer): void {
  const handler = (
    args: SearchFilesArgs,
    extra: { signal: AbortSignal }
  ): Promise<ToolResult<SearchFilesStructuredResult>> =>
    withToolErrorHandling(
      () => handleSearchFiles(args, extra.signal),
      (error) =>
        buildToolErrorResponse(error, ErrorCode.E_INVALID_PATTERN, args.path)
    );

  server.registerTool('search_files', SEARCH_FILES_TOOL, handler);
}
