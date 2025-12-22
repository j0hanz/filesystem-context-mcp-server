import * as pathModule from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode, toRpcError } from '../lib/errors.js';
import { listDirectory } from '../lib/file-operations.js';
import {
  ListDirectoryInputSchema,
  ListDirectoryOutputSchema,
} from '../schemas/index.js';
import { formatBytes, formatOperationSummary } from './shared/formatting.js';
import { buildToolResponse, type ToolResponse } from './tool-response.js';

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
  if (entries.length === 0) return 'Directory is empty';

  const dirs = entries.filter((e) => e.type === 'directory');
  const files = entries.filter((e) => e.type !== 'directory');
  const lines = [
    `Contents of ${basePath}:`,
    '',
    ...formatDirectoryLines(dirs),
    ...formatFileLines(files),
    '',
    `Total: ${dirs.length} directories, ${files.length} files`,
  ];

  return lines.join('\n');
}

function formatDirectoryLines(
  dirs: Awaited<ReturnType<typeof listDirectory>>['entries']
): string[] {
  if (dirs.length === 0) return [];
  return [
    'Directories:',
    ...dirs.map((dir) => {
      const symlink = dir.symlinkTarget ? ` -> ${dir.symlinkTarget}` : '';
      return `  [DIR]  ${dir.relativePath}${symlink}`;
    }),
    '',
  ];
}

function formatFileLines(
  files: Awaited<ReturnType<typeof listDirectory>>['entries']
): string[] {
  if (files.length === 0) return [];
  return [
    'Files:',
    ...files.map((file) => {
      const size =
        file.size !== undefined ? ` (${formatBytes(file.size)})` : '';
      const tag = file.type === 'symlink' ? '[LINK]' : '[FILE]';
      const symlink = file.symlinkTarget ? ` -> ${file.symlinkTarget}` : '';
      return `  ${tag} ${file.relativePath}${size}${symlink}`;
    }),
  ];
}

const LIST_DIRECTORY_TOOL = {
  title: 'List Directory',
  description:
    'List files and subdirectories in a specified path with optional recursive traversal. ' +
    'Returns names, types (file/directory/symlink), sizes, and modification dates. ' +
    'Use recursive=true with maxDepth to explore nested structures. ' +
    'For a visual tree structure, use directory_tree instead.',
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
      name: e.relativePath,
      type: e.type,
      extension: getExtension(e.relativePath, e.type === 'file'),
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
  textOutput += formatOperationSummary({
    truncated: result.summary.truncated,
    truncatedReason: `reached max entries limit (${result.summary.totalEntries} returned)`,
    tip: 'Increase maxEntries or reduce maxDepth to see more results.',
    skippedInaccessible: result.summary.skippedInaccessible,
    symlinksNotFollowed: result.summary.symlinksNotFollowed,
  });
  return textOutput;
}

async function handleListDirectory({
  path: dirPath,
  recursive,
  includeHidden,
  maxDepth,
  maxEntries,
  sortBy,
  includeSymlinkTargets,
}: {
  path: string;
  recursive?: boolean;
  includeHidden?: boolean;
  maxDepth?: number;
  maxEntries?: number;
  sortBy?: 'name' | 'size' | 'modified' | 'type';
  includeSymlinkTargets?: boolean;
}): Promise<ToolResponse<ListDirectoryStructuredResult>> {
  const result = await listDirectory(dirPath, {
    recursive,
    includeHidden,
    maxDepth,
    maxEntries,
    sortBy,
    includeSymlinkTargets,
  });
  const structured = buildStructuredResult(result);
  const textOutput = buildTextResult(result);
  return buildToolResponse(textOutput, structured);
}

export function registerListDirectoryTool(server: McpServer): void {
  server.registerTool(
    'list_directory',
    LIST_DIRECTORY_TOOL,
    async (args: ListDirectoryArgs) => {
      try {
        return await handleListDirectory(args);
      } catch (error: unknown) {
        throw toRpcError(error, ErrorCode.E_NOT_DIRECTORY, args.path);
      }
    }
  );
}
