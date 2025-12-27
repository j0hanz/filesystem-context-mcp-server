import * as pathModule from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import {
  formatBytes,
  formatOperationSummary,
  joinLines,
} from '../config/formatting.js';
import { ErrorCode } from '../lib/errors.js';
import { listDirectory } from '../lib/file-operations.js';
import {
  ListDirectoryInputSchema,
  ListDirectoryOutputSchema,
} from '../schemas/index.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
} from './tool-response.js';

function getExtension(name: string, isFile: boolean): string | undefined {
  if (!isFile) return undefined;
  const ext = pathModule.extname(name);
  return ext ? ext.slice(1) : undefined;
}

type ListDirectoryArgs = z.infer<z.ZodObject<typeof ListDirectoryInputSchema>>;
type ListDirectoryStructuredResult = z.infer<typeof ListDirectoryOutputSchema>;

function formatDirectoryListing(
  entries: Awaited<ReturnType<typeof listDirectory>>['entries'],
  basePath: string
): string {
  if (entries.length === 0) return 'Empty directory';

  const dirs = entries.filter((e) => e.type === 'directory');
  const files = entries.filter((e) => e.type !== 'directory');

  const dirLines = dirs.map((dir) => {
    const symlink = dir.symlinkTarget ? ` -> ${dir.symlinkTarget}` : '';
    return `[DIR] ${dir.relativePath}${symlink}`;
  });

  const fileLines = files.map((file) => {
    const size = file.size !== undefined ? ` (${formatBytes(file.size)})` : '';
    const tag = file.type === 'symlink' ? '[LINK]' : '[FILE]';
    const symlink = file.symlinkTarget ? ` -> ${file.symlinkTarget}` : '';
    return `${tag} ${file.relativePath}${size}${symlink}`;
  });

  const lines = [
    `${basePath} (${dirs.length} dirs, ${files.length} files):`,
    ...dirLines,
    ...fileLines,
  ];

  return joinLines(lines);
}

const LIST_DIRECTORY_TOOL = {
  title: 'List Directory',
  description:
    'List entries in a directory with optional recursion. ' +
    'Returns name (basename), relative path, type (file/directory/symlink), size, and modified date. ' +
    'Use recursive=true with maxDepth to traverse nested folders. ' +
    'Use excludePatterns to skip paths, or pattern to include only matches. ' +
    'Symlinks are not followed; includeSymlinkTargets can show targets.',
  inputSchema: ListDirectoryInputSchema,
  outputSchema: ListDirectoryOutputSchema.shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

function buildStructuredResult(
  result: Awaited<ReturnType<typeof listDirectory>>
): ListDirectoryStructuredResult {
  return {
    ok: true,
    path: result.path,
    entries: result.entries.map((e) => ({
      name: e.name,
      relativePath: e.relativePath,
      type: e.type,
      extension: getExtension(e.name, e.type === 'file'),
      size: e.size,
      modified: e.modified?.toISOString(),
      symlinkTarget: e.symlinkTarget,
    })),
    summary: {
      totalEntries: result.summary.totalEntries,
      totalFiles: result.summary.totalFiles,
      totalDirectories: result.summary.totalDirectories,
      maxDepthReached: result.summary.maxDepthReached,
      truncated: result.summary.truncated,
      skippedInaccessible: result.summary.skippedInaccessible,
      symlinksNotFollowed: result.summary.symlinksNotFollowed,
    },
  };
}

function buildTextResult(
  result: Awaited<ReturnType<typeof listDirectory>>
): string {
  let textOutput = formatDirectoryListing(result.entries, result.path);
  if (result.entries.length === 0 && result.summary.totalEntries > 0) {
    textOutput +=
      '\n(No entries matched the provided pattern/filters, but the directory contains items.)';
  }
  textOutput += formatOperationSummary({
    truncated: result.summary.truncated,
    truncatedReason: `reached max entries limit (${result.summary.totalEntries} returned)`,
    tip: 'Increase maxEntries or reduce maxDepth to see more results.',
    skippedInaccessible: result.summary.skippedInaccessible,
    symlinksNotFollowed: result.summary.symlinksNotFollowed,
  });
  return textOutput;
}

async function handleListDirectory(
  {
    path: dirPath,
    recursive,
    includeHidden,
    excludePatterns,
    maxDepth,
    maxEntries,
    sortBy,
    includeSymlinkTargets,
    pattern,
  }: {
    path: string;
    recursive?: boolean;
    includeHidden?: boolean;
    excludePatterns?: string[];
    maxDepth?: number;
    maxEntries?: number;
    sortBy?: 'name' | 'size' | 'modified' | 'type';
    includeSymlinkTargets?: boolean;
    pattern?: string;
  },
  signal?: AbortSignal
): Promise<ToolResponse<ListDirectoryStructuredResult>> {
  const result = await listDirectory(dirPath, {
    recursive,
    includeHidden,
    excludePatterns,
    maxDepth,
    maxEntries,
    sortBy,
    includeSymlinkTargets,
    pattern,
    signal,
  });
  const structured = buildStructuredResult(result);
  const textOutput = buildTextResult(result);
  return buildToolResponse(textOutput, structured);
}

export function registerListDirectoryTool(server: McpServer): void {
  const handler = async (
    args: ListDirectoryArgs,
    extra: { signal: AbortSignal }
  ): Promise<ToolResult<ListDirectoryStructuredResult>> => {
    try {
      return await handleListDirectory(args, extra.signal);
    } catch (error: unknown) {
      return buildToolErrorResponse(
        error,
        ErrorCode.E_NOT_DIRECTORY,
        args.path
      );
    }
  };

  server.registerTool('list_directory', LIST_DIRECTORY_TOOL, handler);
}
