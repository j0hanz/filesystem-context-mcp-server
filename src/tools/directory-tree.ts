import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode, toRpcError } from '../lib/errors.js';
import { getDirectoryTree } from '../lib/file-operations.js';
import {
  DirectoryTreeInputSchema,
  DirectoryTreeOutputSchema,
} from '../schemas/index.js';
import { buildToolResponse, type ToolResponse } from './tool-response.js';

type DirectoryTreeArgs = z.infer<z.ZodObject<typeof DirectoryTreeInputSchema>>;
type DirectoryTreeStructuredResult = z.infer<typeof DirectoryTreeOutputSchema>;

const BYTE_UNIT_LABELS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const unitIndex = Math.floor(Math.log(bytes) / Math.log(1024));
  const unit = BYTE_UNIT_LABELS[unitIndex] ?? 'B';
  const value = bytes / Math.pow(1024, unitIndex);
  return `${parseFloat(value.toFixed(2))} ${unit}`;
}

function formatTreeEntry(
  entry: Awaited<ReturnType<typeof getDirectoryTree>>['tree'],
  indent = ''
): string {
  const lines: string[] = [];
  const icon = entry.type === 'directory' ? '[DIR]' : '[FILE]';
  const size = entry.size !== undefined ? ` (${formatBytes(entry.size)})` : '';
  lines.push(`${indent}${icon} ${entry.name}${size}`);
  for (const child of entry.children ?? []) {
    lines.push(formatTreeEntry(child, `${indent}  `));
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
  result: Awaited<ReturnType<typeof getDirectoryTree>>
): DirectoryTreeStructuredResult {
  return {
    ok: true,
    tree: result.tree,
    summary: result.summary,
  };
}

function buildTextResult(
  result: Awaited<ReturnType<typeof getDirectoryTree>>
): string {
  let textOutput = formatTreeEntry(result.tree);
  textOutput += formatOperationSummary({
    truncated: result.summary.truncated,
    truncatedReason: 'tree was truncated',
    tip: 'Increase maxDepth or maxFiles, or add excludePatterns to narrow scope.',
    skippedInaccessible: result.summary.skippedInaccessible,
    symlinksNotFollowed: result.summary.symlinksNotFollowed,
  });
  return textOutput;
}

async function handleDirectoryTree({
  path,
  maxDepth,
  excludePatterns,
  includeHidden,
  includeSize,
  maxFiles,
}: {
  path: string;
  maxDepth?: number;
  excludePatterns?: string[];
  includeHidden?: boolean;
  includeSize?: boolean;
  maxFiles?: number;
}): Promise<ToolResponse<DirectoryTreeStructuredResult>> {
  const result = await getDirectoryTree(path, {
    maxDepth,
    excludePatterns,
    includeHidden,
    includeSize,
    maxFiles,
  });
  const structured = buildStructuredResult(result);
  const textOutput = buildTextResult(result);
  return buildToolResponse(textOutput, structured);
}

const DIRECTORY_TREE_TOOL = {
  title: 'Directory Tree',
  description:
    'Generate a hierarchical JSON tree structure of a directory. ' +
    'More efficient for AI parsing than flat file lists. ' +
    'Ideal for understanding project layout and structure at a glance. ' +
    'Use maxDepth to limit traversal depth and excludePatterns to skip folders like node_modules. ' +
    'Optionally include file sizes with includeSize=true.',
  inputSchema: DirectoryTreeInputSchema,
  outputSchema: DirectoryTreeOutputSchema.shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

export function registerDirectoryTreeTool(server: McpServer): void {
  server.registerTool(
    'directory_tree',
    DIRECTORY_TREE_TOOL,
    async (args: DirectoryTreeArgs) => {
      try {
        return await handleDirectoryTree(args);
      } catch (error: unknown) {
        throw toRpcError(error, ErrorCode.E_NOT_DIRECTORY, args.path);
      }
    }
  );
}
