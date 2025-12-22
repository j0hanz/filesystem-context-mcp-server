import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode, toRpcError } from '../lib/errors.js';
import { getDirectoryTree } from '../lib/file-operations.js';
import {
  DirectoryTreeInputSchema,
  DirectoryTreeOutputSchema,
} from '../schemas/index.js';
import { formatBytes, formatOperationSummary } from './shared/formatting.js';
import { buildToolResponse, type ToolResponse } from './tool-response.js';

type DirectoryTreeArgs = z.infer<z.ZodObject<typeof DirectoryTreeInputSchema>>;
type DirectoryTreeStructuredResult = z.infer<typeof DirectoryTreeOutputSchema>;

function formatTreeEntry(
  entry: Awaited<ReturnType<typeof getDirectoryTree>>['tree'],
  indent = ''
): string {
  return formatTreeEntryLines(entry, indent).join('\n');
}

function formatTreeEntryLines(
  entry: Awaited<ReturnType<typeof getDirectoryTree>>['tree'],
  indent: string
): string[] {
  const lines = [formatTreeEntryLine(entry, indent)];
  for (const child of entry.children ?? []) {
    lines.push(...formatTreeEntryLines(child, `${indent}  `));
  }
  return lines;
}

function formatTreeEntryLine(
  entry: Awaited<ReturnType<typeof getDirectoryTree>>['tree'],
  indent: string
): string {
  const icon = entry.type === 'directory' ? '[DIR]' : '[FILE]';
  const size = entry.size !== undefined ? ` (${formatBytes(entry.size)})` : '';
  return `${indent}${icon} ${entry.name}${size}`;
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
