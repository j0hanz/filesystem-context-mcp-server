import * as pathModule from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode, toRpcError } from '../lib/errors.js';
import { listDirectory } from '../lib/file-operations.js';
import {
  ListDirectoryInputSchema,
  ListDirectoryOutputSchema,
} from '../schemas/index.js';
import { buildToolResponse, type ToolResponse } from './tool-response.js';

function getExtension(name: string, isFile: boolean): string | undefined {
  if (!isFile) return undefined;
  const ext = pathModule.extname(name);
  return ext ? ext.slice(1) : undefined;
}

type ListDirectoryArgs = z.infer<z.ZodObject<typeof ListDirectoryInputSchema>>;
type ListDirectoryStructuredResult = z.infer<typeof ListDirectoryOutputSchema>;

const BYTE_UNIT_LABELS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const unitIndex = Math.floor(Math.log(bytes) / Math.log(1024));
  const unit = BYTE_UNIT_LABELS[unitIndex] ?? 'B';
  const value = bytes / Math.pow(1024, unitIndex);
  return `${parseFloat(value.toFixed(2))} ${unit}`;
}

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
    ...(dirs.length
      ? [
          'Directories:',
          ...dirs.map((dir) => {
            const symlink = dir.symlinkTarget ? ` -> ${dir.symlinkTarget}` : '';
            return `  [DIR]  ${dir.relativePath}${symlink}`;
          }),
          '',
        ]
      : []),
    ...(files.length
      ? [
          'Files:',
          ...files.map((file) => {
            const size =
              file.size !== undefined ? ` (${formatBytes(file.size)})` : '';
            const tag = file.type === 'symlink' ? '[LINK]' : '[FILE]';
            const symlink = file.symlinkTarget
              ? ` -> ${file.symlinkTarget}`
              : '';
            return `  ${tag} ${file.relativePath}${size}${symlink}`;
          }),
        ]
      : []),
    '',
    `Total: ${dirs.length} directories, ${files.length} files`,
  ];

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
    if (summary.tip) {
      lines.push(`Tip: ${summary.tip}`);
    }
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
