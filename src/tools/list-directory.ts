import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode } from '../lib/errors.js';
import { listDirectory } from '../lib/file-operations/list-directory.js';
import { withToolDiagnostics } from '../lib/observability/diagnostics.js';
import { getAllowedDirectories } from '../lib/path-validation/allowed-directories.js';
import {
  ListDirectoryInputSchema,
  ListDirectoryOutputSchema,
} from '../schemas/index.js';
import { buildTextResult } from './list-directory-formatting.js';
import { withTimedSignal } from './shared/with-timed-signal.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
  withToolErrorHandling,
} from './tool-response.js';

type ListDirectoryArgs = z.infer<typeof ListDirectoryInputSchema>;
type ListDirectoryStructuredResult = z.infer<typeof ListDirectoryOutputSchema>;
type ListDirectoryStructuredEntry = NonNullable<
  ListDirectoryStructuredResult['entries']
>[number];

function resolvePathOrRoot(path: string | undefined): string {
  if (path && path.trim().length > 0) return path;
  const roots = getAllowedDirectories();
  const firstRoot = roots[0];
  if (!firstRoot) {
    throw new Error('No workspace roots configured. Use roots to check.');
  }
  return firstRoot;
}

const LIST_DIRECTORY_TOOL = {
  title: 'List Directory',
  description:
    'List the immediate contents of a directory (non-recursive). ' +
    'Returns name, relative path, type (file/directory/symlink), size, and modified date. ' +
    'Omit path to list the workspace root. ' +
    'For recursive searches, use find instead.',
  inputSchema: ListDirectoryInputSchema,
  outputSchema: ListDirectoryOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

function buildStructuredEntry(
  entry: Awaited<ReturnType<typeof listDirectory>>['entries'][number]
): ListDirectoryStructuredEntry {
  return {
    name: entry.name,
    relativePath: entry.relativePath,
    type: entry.type,
    size: entry.size,
    modified: entry.modified?.toISOString(),
  };
}

function buildStructuredResult(
  result: Awaited<ReturnType<typeof listDirectory>>
): ListDirectoryStructuredResult {
  const { entries, summary, path } = result;
  return {
    ok: true,
    path,
    entries: entries.map(buildStructuredEntry),
    totalEntries: summary.totalEntries,
  };
}

async function handleListDirectory(
  args: ListDirectoryArgs,
  signal?: AbortSignal
): Promise<ToolResponse<ListDirectoryStructuredResult>> {
  const dirPath = resolvePathOrRoot(args.path);
  const result = await listDirectory(dirPath, {
    includeHidden: args.includeHidden,
    excludePatterns: args.excludePatterns,
    pattern: args.pattern,
    maxDepth: args.maxDepth,
    maxEntries: args.maxEntries,
    timeoutMs: args.timeoutMs,
    sortBy: args.sortBy,
    includeSymlinkTargets: args.includeSymlinkTargets,
    signal,
  });
  return buildToolResponse(
    buildTextResult(result),
    buildStructuredResult(result)
  );
}

async function runListDirectoryWithTimeout(
  args: ListDirectoryArgs,
  signal: AbortSignal
): Promise<ToolResponse<ListDirectoryStructuredResult>> {
  return await withTimedSignal(
    signal,
    args.timeoutMs,
    handleListDirectory.bind(null, args)
  );
}

function mapListDirectoryError(
  args: ListDirectoryArgs,
  error: unknown
): ToolResult<ListDirectoryStructuredResult> {
  return buildToolErrorResponse(
    error,
    ErrorCode.E_NOT_DIRECTORY,
    args.path ?? '.'
  );
}

async function runListDirectoryWithErrorHandling(
  args: ListDirectoryArgs,
  extra: { signal: AbortSignal }
): Promise<ToolResult<ListDirectoryStructuredResult>> {
  return await withToolErrorHandling(
    runListDirectoryWithTimeout.bind(null, args, extra.signal),
    mapListDirectoryError.bind(null, args)
  );
}

function createListDirectoryHandler(): (
  args: ListDirectoryArgs,
  extra: { signal: AbortSignal }
) => Promise<ToolResult<ListDirectoryStructuredResult>> {
  return (args, extra) =>
    withToolDiagnostics(
      'ls',
      runListDirectoryWithErrorHandling.bind(null, args, extra),
      { path: args.path ?? '.' }
    );
}

export function registerListDirectoryTool(server: McpServer): void {
  server.registerTool('ls', LIST_DIRECTORY_TOOL, createListDirectoryHandler());
}
