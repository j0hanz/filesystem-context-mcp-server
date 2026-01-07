import * as pathModule from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import {
  formatBytes,
  formatOperationSummary,
  joinLines,
} from '../config/formatting.js';
import { ErrorCode } from '../lib/errors.js';
import { searchFiles } from '../lib/file-operations/search-files.js';
import { withToolDiagnostics } from '../lib/observability/diagnostics.js';
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

type SearchFilesArgs = z.infer<typeof SearchFilesInputSchema>;
type SearchFilesStructuredResult = z.infer<typeof SearchFilesOutputSchema>;
function formatSearchResults(
  results: Awaited<ReturnType<typeof searchFiles>>['results'],
  basePath: string
): string {
  if (results.length === 0) return 'No matches';

  const lines = results.map((result) => {
    const tag = result.type === 'directory' ? '[DIR]' : '[FILE]';
    const size =
      result.size !== undefined ? ` (${formatBytes(result.size)})` : '';
    return `${tag} ${pathModule.relative(basePath, result.path)}${size}`;
  });
  return joinLines([`Found ${results.length}:`, ...lines]);
}

function buildStructuredResult(
  result: Awaited<ReturnType<typeof searchFiles>>,
  args: SearchFilesArgs
): SearchFilesStructuredResult {
  const { basePath, pattern, results, summary } = result;
  return {
    ok: true,
    basePath,
    pattern,
    results: results.map((entry) => ({
      path: pathModule.relative(basePath, entry.path),
      type: entry.type === 'directory' ? 'other' : entry.type,
      size: entry.size,
      modified: entry.modified?.toISOString(),
    })),
    summary: {
      matched: summary.matched,
      truncated: summary.truncated,
      skippedInaccessible: summary.skippedInaccessible,
      filesScanned: summary.filesScanned,
      stoppedReason: summary.stoppedReason,
    },
    effectiveOptions: {
      excludePatterns: [...args.excludePatterns],
      maxResults: args.maxResults,
    },
  };
}

function buildTextResult(
  result: Awaited<ReturnType<typeof searchFiles>>
): string {
  const { summary, results } = result;
  let truncatedReason: string | undefined;
  let tip: string | undefined;
  if (summary.truncated) {
    switch (summary.stoppedReason) {
      case 'timeout':
        truncatedReason = 'search timed out';
        tip =
          'Increase timeoutMs, use a more specific pattern, or add excludePatterns to narrow scope.';
        break;
      case 'maxResults':
        truncatedReason = `reached max results limit (${summary.matched} returned)`;
        break;
      case 'maxFiles':
        truncatedReason = `reached max files limit (${summary.filesScanned} scanned)`;
        break;
      default:
        break;
    }
  }
  const header = joinLines([
    `Base path: ${result.basePath}`,
    `Pattern: ${result.pattern}`,
  ]);
  const body = formatSearchResults(results, result.basePath);
  let textOutput = joinLines([header, body]);
  if (results.length === 0) {
    textOutput +=
      '\n(Try a broader pattern or remove excludePatterns to see more results.)';
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
  args: SearchFilesArgs,
  signal?: AbortSignal
): Promise<ToolResponse<SearchFilesStructuredResult>> {
  const { path: searchBasePath, pattern, excludePatterns, maxResults } = args;
  const result = await searchFiles(searchBasePath, pattern, excludePatterns, {
    maxResults,
    signal,
  });
  return buildToolResponse(
    buildTextResult(result),
    buildStructuredResult(result, args)
  );
}

const SEARCH_FILES_TOOL = {
  title: 'Search Files',
  description:
    'Find files (not directories) matching a glob pattern within a directory tree. ' +
    'Pattern examples: "**/*.ts" (all TypeScript files), "src/**/*.{js,jsx}" (JS/JSX in src), ' +
    '"**/test/**" (all test directories). Returns paths, types, sizes, and modification dates. ' +
    'excludePatterns defaults to common dependency/build dirs (pass [] to disable).',
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
  server.registerTool('search_files', SEARCH_FILES_TOOL, ((args, extra) =>
    withToolDiagnostics(
      'search_files',
      () =>
        withToolErrorHandling(
          async () => await handleSearchFiles(args, extra.signal),
          (error) =>
            buildToolErrorResponse(
              error,
              ErrorCode.E_INVALID_PATTERN,
              args.path
            )
        ),
      { path: args.path }
    )) satisfies SearchFilesToolHandler);
}
