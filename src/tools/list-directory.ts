import * as pathModule from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import {
  DEFAULT_LIST_MAX_ENTRIES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { listDirectory } from '../lib/file-operations/list-directory.js';
import { createTimedAbortSignal } from '../lib/fs-helpers/abort.js';
import { withToolDiagnostics } from '../lib/observability/diagnostics.js';
import {
  ListDirectoryInputSchema,
  ListDirectoryOutputSchema,
} from '../schemas/index.js';
import { buildTextResult } from './list-directory-formatting.js';
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

const LIST_DIRECTORY_TOOL = {
  title: 'List Directory',
  description:
    'List entries in a directory with optional recursion. ' +
    'Returns name (basename), relative path, type (file/directory/symlink), size, and modified date. ' +
    'Use recursive=true to traverse nested folders. ' +
    'Use excludePatterns to skip paths. For filtered file searches, use search_files instead.',
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
    extension:
      entry.type === 'file'
        ? pathModule.extname(entry.name).replace('.', '') || undefined
        : undefined,
    size: entry.size,
    modified: entry.modified?.toISOString(),
    symlinkTarget: entry.symlinkTarget,
  };
}

function buildStructuredSummary(
  summary: Awaited<ReturnType<typeof listDirectory>>['summary']
): ListDirectoryStructuredResult['summary'] {
  return {
    totalEntries: summary.totalEntries,
    totalFiles: summary.totalFiles,
    totalDirectories: summary.totalDirectories,
    maxDepthReached: summary.maxDepthReached,
    truncated: summary.truncated,
    stoppedReason: summary.stoppedReason,
    skippedInaccessible: summary.skippedInaccessible,
    symlinksNotFollowed: summary.symlinksNotFollowed,
    entriesScanned: summary.entriesScanned,
    entriesVisible: summary.entriesVisible,
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
    summary: buildStructuredSummary(summary),
  };
}

function buildListDirectoryOptions(
  options: Omit<ListDirectoryArgs, 'path'>,
  signal?: AbortSignal
): Parameters<typeof listDirectory>[1] {
  return {
    ...options,
    includeHidden: false,
    maxDepth: DEFAULT_MAX_DEPTH,
    maxEntries: DEFAULT_LIST_MAX_ENTRIES,
    timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
    sortBy: 'name' as const,
    includeSymlinkTargets: false,
    pattern: undefined, // No pattern filtering
    signal,
  };
}

async function handleListDirectory(
  args: ListDirectoryArgs,
  signal?: AbortSignal
): Promise<ToolResponse<ListDirectoryStructuredResult>> {
  const { path: dirPath, ...options } = args;
  // Hardcode removed parameters with sensible defaults
  const result = await listDirectory(
    dirPath,
    buildListDirectoryOptions(options, signal)
  );
  const structured = buildStructuredResult(result);
  structured.effectiveOptions = {
    recursive: options.recursive,
    excludePatterns: [...options.excludePatterns],
  };
  const textOutput = buildTextResult(result);
  return buildToolResponse(textOutput, structured);
}

export function registerListDirectoryTool(server: McpServer): void {
  const handler = (
    args: ListDirectoryArgs,
    extra: { signal: AbortSignal }
  ): Promise<ToolResult<ListDirectoryStructuredResult>> =>
    withToolDiagnostics(
      'list_directory',
      () =>
        withToolErrorHandling(
          async () => {
            const { signal, cleanup } = createTimedAbortSignal(
              extra.signal,
              DEFAULT_SEARCH_TIMEOUT_MS
            );
            try {
              return await handleListDirectory(args, signal);
            } finally {
              cleanup();
            }
          },
          (error) =>
            buildToolErrorResponse(error, ErrorCode.E_NOT_DIRECTORY, args.path)
        ),
      { path: args.path }
    );

  server.registerTool('list_directory', LIST_DIRECTORY_TOOL, handler);
}
