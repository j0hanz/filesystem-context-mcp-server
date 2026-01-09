import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode } from '../lib/errors.js';
import { listDirectory } from '../lib/file-operations/list-directory.js';
import { createTimedAbortSignal } from '../lib/fs-helpers/abort.js';
import { withToolDiagnostics } from '../lib/observability/diagnostics.js';
import { getAllowedDirectories } from '../lib/path-validation/allowed-directories.js';
import {
  ListDirectoryInputSchema,
  ListDirectoryOutputSchema,
} from '../schemas/index.js';
import { buildTextResult } from './list-directory-formatting.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
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
  const options: Parameters<typeof listDirectory>[1] = {
    includeHidden: args.includeHidden,
    excludePatterns: args.excludePatterns,
    maxDepth: args.maxDepth,
    maxEntries: args.maxEntries,
    timeoutMs: args.timeoutMs,
    sortBy: args.sortBy,
    includeSymlinkTargets: args.includeSymlinkTargets,
    ...(args.pattern !== undefined ? { pattern: args.pattern } : {}),
    ...(signal ? { signal } : {}),
  };
  const result = await listDirectory(dirPath, options);
  return buildToolResponse(
    buildTextResult(result),
    buildStructuredResult(result)
  );
}

export function registerListDirectoryTool(server: McpServer): void {
  server.registerTool('ls', LIST_DIRECTORY_TOOL, (args, extra) =>
    withToolDiagnostics(
      'ls',
      () =>
        withToolErrorHandling(
          async () => {
            const { signal, cleanup } = createTimedAbortSignal(
              extra.signal,
              args.timeoutMs
            );
            try {
              return await handleListDirectory(args, signal);
            } finally {
              cleanup();
            }
          },
          (error) =>
            buildToolErrorResponse(
              error,
              ErrorCode.E_NOT_DIRECTORY,
              args.path ?? '.'
            )
        ),
      { path: args.path ?? '.' }
    )
  );
}
