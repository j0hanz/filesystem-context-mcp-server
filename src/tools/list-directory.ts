import * as pathModule from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import {
  formatBytes,
  formatOperationSummary,
  joinLines,
} from '../config/formatting.js';
import {
  DEFAULT_LIST_MAX_ENTRIES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { listDirectory } from '../lib/file-operations.js';
import { createTimedAbortSignal } from '../lib/fs-helpers.js';
import { mergeDefined } from '../lib/merge-defined.js';
import { withToolDiagnostics } from '../lib/observability/diagnostics.js';
import {
  ListDirectoryInputSchema,
  ListDirectoryOutputSchema,
} from '../schemas/index.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
  withToolErrorHandling,
} from './tool-response.js';

function getExtension(name: string, isFile: boolean): string | undefined {
  if (!isFile) return undefined;
  const ext = pathModule.extname(name);
  return ext ? ext.slice(1) : undefined;
}

type ListDirectoryArgs = z.infer<typeof ListDirectoryInputSchema>;
type ListDirectoryStructuredResult = z.infer<typeof ListDirectoryOutputSchema>;
type DirectoryEntryItem = Awaited<
  ReturnType<typeof listDirectory>
>['entries'][number];

type ListSort = 'name' | 'size' | 'modified' | 'type';

interface ListOptions {
  recursive: boolean;
  includeHidden: boolean;
  excludePatterns: readonly string[];
  maxDepth: number;
  maxEntries: number;
  timeoutMs: number;
  sortBy: ListSort;
  includeSymlinkTargets: boolean;
  pattern?: string;
}

const DEFAULT_LIST_OPTIONS: ListOptions = {
  recursive: false,
  includeHidden: false,
  excludePatterns: [],
  maxDepth: DEFAULT_MAX_DEPTH,
  maxEntries: DEFAULT_LIST_MAX_ENTRIES,
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  sortBy: 'name',
  includeSymlinkTargets: false,
  pattern: undefined,
};

function buildEffectiveListOptions(
  overrides: Partial<ListOptions>
): ListOptions {
  return mergeDefined(DEFAULT_LIST_OPTIONS, overrides);
}

function formatDirectoryListing(
  entries: Awaited<ReturnType<typeof listDirectory>>['entries'],
  basePath: string,
  summary: Awaited<ReturnType<typeof listDirectory>>['summary']
): string {
  if (entries.length === 0) {
    return formatEmptyDirectoryListing(summary);
  }

  const dirs = entries.filter((e) => e.type === 'directory').length;
  const files = entries.length - dirs;

  const entryLines = entries.map(formatDirectoryEntry);

  const lines = [`${basePath} (${dirs} dirs, ${files} files):`, ...entryLines];

  return joinLines(lines);
}

function formatDirectoryEntry(entry: DirectoryEntryItem): string {
  if (entry.type === 'directory') {
    return formatDirectoryLine(entry);
  }
  return formatFileLine(entry);
}

function formatDirectoryLine(entry: DirectoryEntryItem): string {
  return `[DIR] ${entry.relativePath}${formatSymlinkSuffix(entry.symlinkTarget)}`;
}

function formatFileLine(entry: DirectoryEntryItem): string {
  const size = formatSizeSuffix(entry.size);
  const tag = formatEntryTag(entry.type);
  return `${tag} ${entry.relativePath}${size}${formatSymlinkSuffix(entry.symlinkTarget)}`;
}

function formatEntryTag(type: DirectoryEntryItem['type']): string {
  if (type === 'symlink') return '[LINK]';
  return '[FILE]';
}

function formatSizeSuffix(size: number | undefined): string {
  if (size === undefined) return '';
  return ` (${formatBytes(size)})`;
}

function formatSymlinkSuffix(target: string | undefined): string {
  if (!target) return '';
  return ` -> ${target}`;
}

function formatEmptyDirectoryListing(
  summary: Awaited<ReturnType<typeof listDirectory>>['summary']
): string {
  if (!summary.entriesScanned || summary.entriesScanned === 0) {
    return 'Empty directory';
  }
  if (summary.entriesVisible === 0) {
    return 'No entries matched visibility filters (hidden/excludePatterns).';
  }
  return 'No entries matched the provided pattern.';
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
  outputSchema: ListDirectoryOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

function buildStructuredResult(
  result: Awaited<ReturnType<typeof listDirectory>>
): ListDirectoryStructuredResult {
  const { entries, summary, path } = result;
  return {
    ok: true,
    path,
    entries: entries.map((e) => ({
      name: e.name,
      relativePath: e.relativePath,
      type: e.type,
      extension: getExtension(e.name, e.type === 'file'),
      size: e.size,
      modified: e.modified?.toISOString(),
      symlinkTarget: e.symlinkTarget,
    })),
    summary: {
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
    },
  };
}

function buildTextResult(
  result: Awaited<ReturnType<typeof listDirectory>>
): string {
  const { entries, summary, path } = result;
  let textOutput = formatDirectoryListing(entries, path, summary);
  const truncatedReason =
    summary.stoppedReason === 'aborted'
      ? 'operation aborted'
      : summary.stoppedReason === 'maxEntries'
        ? `reached max entries limit (${summary.totalEntries} returned)`
        : undefined;
  textOutput += formatOperationSummary({
    truncated: summary.truncated,
    truncatedReason,
    tip:
      summary.stoppedReason === 'maxEntries'
        ? 'Increase maxEntries or reduce maxDepth to see more results.'
        : undefined,
    skippedInaccessible: summary.skippedInaccessible,
    symlinksNotFollowed: summary.symlinksNotFollowed,
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
    timeoutMs,
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
    timeoutMs?: number;
    sortBy?: 'name' | 'size' | 'modified' | 'type';
    includeSymlinkTargets?: boolean;
    pattern?: string;
  },
  signal?: AbortSignal
): Promise<ToolResponse<ListDirectoryStructuredResult>> {
  const effectiveOptions = buildEffectiveListOptions({
    recursive,
    includeHidden,
    excludePatterns,
    maxDepth,
    maxEntries,
    timeoutMs,
    sortBy,
    includeSymlinkTargets,
    pattern,
  });
  const result = await listDirectory(dirPath, {
    recursive: effectiveOptions.recursive,
    includeHidden: effectiveOptions.includeHidden,
    excludePatterns: effectiveOptions.excludePatterns,
    maxDepth: effectiveOptions.maxDepth,
    maxEntries: effectiveOptions.maxEntries,
    // AbortSignal timeout is enforced by createTimedAbortSignal.
    sortBy: effectiveOptions.sortBy,
    includeSymlinkTargets: effectiveOptions.includeSymlinkTargets,
    pattern: effectiveOptions.pattern,
    signal,
  });
  const structured = buildStructuredResult(result);
  structured.effectiveOptions = {
    ...effectiveOptions,
    excludePatterns: [...effectiveOptions.excludePatterns],
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
              args.timeoutMs
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
