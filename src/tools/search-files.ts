import * as pathModule from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { formatOperationSummary, joinLines } from '../config/formatting.js';
import { DEFAULT_EXCLUDE_PATTERNS } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { searchFiles } from '../lib/file-operations/search-files.js';
import { withToolDiagnostics } from '../lib/observability/diagnostics.js';
import {
  SearchFilesInputSchema,
  SearchFilesOutputSchema,
} from '../schemas/index.js';
import { resolvePathOrRoot } from './shared/resolve-path.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
  withToolErrorHandling,
} from './tool-response.js';

type SearchFilesArgs = z.infer<typeof SearchFilesInputSchema>;
type SearchFilesStructuredResult = z.infer<typeof SearchFilesOutputSchema>;

function buildStructuredResult(
  result: Awaited<ReturnType<typeof searchFiles>>
): SearchFilesStructuredResult {
  const { basePath, results, summary } = result;
  return {
    ok: true,
    results: results.map((entry) => ({
      path: pathModule.relative(basePath, entry.path),
      size: entry.size,
      modified: entry.modified?.toISOString(),
    })),
    totalMatches: summary.matched,
    truncated: summary.truncated,
  };
}

function buildTextResult(
  result: Awaited<ReturnType<typeof searchFiles>>
): string {
  const { results, summary, basePath } = result;
  if (results.length === 0) return 'No matches';

  const lines = results.map((r) => {
    const suffix = r.type === 'directory' ? '/' : '';
    return `  ${pathModule.relative(basePath, r.path)}${suffix}`;
  });

  const truncatedReason = summary.truncated
    ? `max results (${summary.matched})`
    : undefined;
  const summaryOptions: Parameters<typeof formatOperationSummary>[0] = {
    truncated: summary.truncated,
  };
  if (truncatedReason !== undefined) {
    summaryOptions.truncatedReason = truncatedReason;
  }
  return (
    joinLines([`Found ${results.length}:`, ...lines]) +
    formatOperationSummary(summaryOptions)
  );
}

async function handleSearchFiles(
  args: SearchFilesArgs,
  signal?: AbortSignal
): Promise<ToolResponse<SearchFilesStructuredResult>> {
  const searchBasePath = resolvePathOrRoot(args.path);
  const options: Parameters<typeof searchFiles>[3] = {
    maxResults: args.maxResults,
  };
  if (signal) {
    options.signal = signal;
  }
  const result = await searchFiles(
    searchBasePath,
    args.pattern,
    DEFAULT_EXCLUDE_PATTERNS,
    options
  );
  return buildToolResponse(
    buildTextResult(result),
    buildStructuredResult(result)
  );
}

const SEARCH_FILES_TOOL = {
  title: 'Search Files',
  description:
    'Find files matching a glob pattern within a directory tree. ' +
    'Pattern examples: "**/*.ts" (all TypeScript), "src/**/*.js" (JS in src). ' +
    'Omit path to search from workspace root. ' +
    'Excludes node_modules, dist, .git automatically.',
  inputSchema: SearchFilesInputSchema,
  outputSchema: SearchFilesOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

type SearchFilesToolHandler = (
  args: SearchFilesArgs,
  extra: { signal: AbortSignal }
) => Promise<ToolResult<SearchFilesStructuredResult>>;

export function registerSearchFilesTool(server: McpServer): void {
  server.registerTool('find', SEARCH_FILES_TOOL, ((args, extra) =>
    withToolDiagnostics(
      'find',
      () =>
        withToolErrorHandling(
          async () => await handleSearchFiles(args, extra.signal),
          (error) =>
            buildToolErrorResponse(
              error,
              ErrorCode.E_INVALID_PATTERN,
              args.path ?? '.'
            )
        ),
      { path: args.path ?? '.' }
    )) satisfies SearchFilesToolHandler);
}
