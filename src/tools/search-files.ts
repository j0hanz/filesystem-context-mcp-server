import * as pathModule from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode, toRpcError } from '../lib/errors.js';
import { searchFiles } from '../lib/file-operations.js';
import {
  SearchFilesInputSchema,
  SearchFilesOutputSchema,
} from '../schemas/index.js';
import { buildToolResponse, type ToolResponse } from './tool-response.js';

type SearchFilesArgs = z.infer<z.ZodObject<typeof SearchFilesInputSchema>>;
type SearchFilesStructuredResult = z.infer<typeof SearchFilesOutputSchema>;

const BYTE_UNIT_LABELS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const unitIndex = Math.floor(Math.log(bytes) / Math.log(1024));
  const unit = BYTE_UNIT_LABELS[unitIndex] ?? 'B';
  const value = bytes / Math.pow(1024, unitIndex);
  return `${parseFloat(value.toFixed(2))} ${unit}`;
}

function formatSearchResults(
  results: Awaited<ReturnType<typeof searchFiles>>['results']
): string {
  if (results.length === 0) return 'No matches found';
  const lines = [`Found ${results.length} matches:`, ''];
  for (const result of results) {
    const tag = result.type === 'directory' ? '[DIR]' : '[FILE]';
    const size =
      result.size !== undefined ? ` (${formatBytes(result.size)})` : '';
    lines.push(`${tag} ${result.path}${size}`);
  }
  return lines.join('\n');
}

function formatOperationSummary(summary: {
  truncated?: boolean;
  truncatedReason?: string;
  tip?: string;
  skippedInaccessible?: number;
  symlinksNotFollowed?: number;
  skippedTooLarge?: number;
  skippedBinary?: number;
  linesSkippedDueToRegexTimeout?: number;
}): string {
  const lines: string[] = [];
  if (summary.truncated) {
    lines.push(
      `\n\n!! PARTIAL RESULTS: ${summary.truncatedReason ?? 'results truncated'}`
    );
    if (summary.tip) lines.push(`Tip: ${summary.tip}`);
  }
  const note = (count: number | undefined, msg: string): void => {
    if (count && count > 0) lines.push(`Note: ${count} ${msg}`);
  };
  note(summary.skippedTooLarge, 'file(s) skipped (too large).');
  note(summary.skippedBinary, 'file(s) skipped (binary).');
  note(summary.skippedInaccessible, 'item(s) were inaccessible and skipped.');
  note(summary.symlinksNotFollowed, 'symlink(s) were not followed (security).');
  note(
    summary.linesSkippedDueToRegexTimeout,
    'line(s) skipped (regex timeout).'
  );
  return lines.join('\n');
}

function buildStructuredResult(
  result: Awaited<ReturnType<typeof searchFiles>>
): SearchFilesStructuredResult {
  return {
    ok: true,
    basePath: result.basePath,
    pattern: result.pattern,
    results: result.results.map((r) => ({
      path: pathModule.relative(result.basePath, r.path),
      type: r.type,
      size: r.size,
      modified: r.modified?.toISOString(),
    })),
    summary: {
      matched: result.summary.matched,
      truncated: result.summary.truncated,
      skippedInaccessible: result.summary.skippedInaccessible,
      filesScanned: result.summary.filesScanned,
      stoppedReason: result.summary.stoppedReason,
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
  const { truncatedReason, tip } = buildTruncationInfo(result);
  let textOutput = formatSearchResults(result.results);
  textOutput += formatOperationSummary({
    truncated: result.summary.truncated,
    truncatedReason,
    tip:
      tip ??
      (result.summary.truncated
        ? 'Increase maxResults, use more specific pattern, or add excludePatterns to narrow scope.'
        : undefined),
    skippedInaccessible: result.summary.skippedInaccessible,
  });
  return textOutput;
}

async function handleSearchFiles({
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
}): Promise<ToolResponse<SearchFilesStructuredResult>> {
  const result = await searchFiles(searchBasePath, pattern, excludePatterns, {
    maxResults,
    sortBy,
    maxDepth,
    maxFilesScanned,
    timeoutMs,
    baseNameMatch,
    skipSymlinks,
  });
  return buildToolResponse(
    buildTextResult(result),
    buildStructuredResult(result)
  );
}

const SEARCH_FILES_TOOL = {
  title: 'Search Files',
  description:
    'Find files matching a glob pattern within a directory tree. ' +
    'Pattern examples: "**/*.ts" (all TypeScript files), "src/**/*.{js,jsx}" (JS/JSX in src), ' +
    '"**/test/**" (all test directories). Returns paths, types, sizes, and modification dates. ' +
    'Use excludePatterns to skip directories like node_modules.',
  inputSchema: SearchFilesInputSchema,
  outputSchema: SearchFilesOutputSchema.shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

export function registerSearchFilesTool(server: McpServer): void {
  server.registerTool(
    'search_files',
    SEARCH_FILES_TOOL,
    async (args: SearchFilesArgs) => {
      try {
        return await handleSearchFiles(args);
      } catch (error: unknown) {
        throw toRpcError(error, ErrorCode.E_INVALID_PATTERN, args.path);
      }
    }
  );
}
