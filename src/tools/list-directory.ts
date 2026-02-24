import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { formatOperationSummary, joinLines } from '../config.js';
import { DEFAULT_EXCLUDE_PATTERNS } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { listDirectory } from '../lib/file-operations/list-directory.js';
import {
  ListDirectoryInputSchema,
  ListDirectoryOutputSchema,
} from '../schemas.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  executeToolWithDiagnostics,
  READ_ONLY_TOOL_ANNOTATIONS,
  resolvePathOrRoot,
  type ToolContract,
  type ToolExtra,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
  withDefaultIcons,
  withValidatedArgs,
  wrapToolHandler,
} from './shared.js';
import { registerToolTaskIfAvailable } from './task-support.js';

export const LIST_DIRECTORY_TOOL: ToolContract = {
  name: 'ls',
  title: 'List Directory',
  description:
    'List the immediate contents of a directory (non-recursive). ' +
    'Returns name, relative path, type (file/directory/symlink), size, and modified date. ' +
    'Omit path to list the workspace root. ' +
    'Use includeIgnored=true to include ignored directories like node_modules. ' +
    'For recursive searches, use find instead.',
  inputSchema: ListDirectoryInputSchema,
  outputSchema: ListDirectoryOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  taskSupport: 'optional',
  nuances: ['`pattern` enables filtered recursive traversal up to `maxDepth`.'],
} as const;

function buildListTextResult(
  result: Awaited<ReturnType<typeof listDirectory>>,
  nextCursor?: string
): string {
  const { entries, summary, path } = result;
  if (entries.length === 0) {
    if (!summary.entriesScanned || summary.entriesScanned === 0) {
      return `${path} (empty)`;
    }
    return `${path} (no matches)`;
  }

  const lines = [path];
  for (const entry of entries) {
    const suffix = entry.type === 'directory' ? '/' : '';
    lines.push(`  ${entry.relativePath}${suffix}`);
  }

  let truncatedReason: string | undefined;
  if (summary.truncated) {
    if (summary.stoppedReason === 'maxEntries') {
      truncatedReason = `max entries (${summary.totalEntries})`;
    } else {
      truncatedReason = 'aborted';
    }
  }

  const summaryOptions: Parameters<typeof formatOperationSummary>[0] = {
    truncated: summary.truncated,
    ...(truncatedReason ? { truncatedReason } : {}),
  };

  let text = joinLines(lines) + formatOperationSummary(summaryOptions);
  if (nextCursor) {
    text += `\n[Next page available. Use cursor: "${nextCursor}"]`;
  }
  return text;
}

function buildStructuredListEntry(
  entry: Awaited<ReturnType<typeof listDirectory>>['entries'][number]
): NonNullable<z.infer<typeof ListDirectoryOutputSchema>['entries']>[number] {
  return {
    name: entry.name,
    relativePath: entry.relativePath,
    type: entry.type,
    size: entry.size,
    modified: entry.modified?.toISOString(),
  };
}

function buildStructuredListResult(
  result: Awaited<ReturnType<typeof listDirectory>>,
  nextCursor?: string
): z.infer<typeof ListDirectoryOutputSchema> {
  const { entries, summary, path: resultPath } = result;
  const structuredEntries: NonNullable<
    z.infer<typeof ListDirectoryOutputSchema>['entries']
  > = [];
  for (const entry of entries) {
    structuredEntries.push(buildStructuredListEntry(entry));
  }
  return {
    ok: true,
    path: resultPath,
    entries: structuredEntries,
    totalEntries: summary.totalEntries,
    ...(summary.truncated ? { truncated: summary.truncated } : {}),
    totalFiles: summary.totalFiles,
    totalDirectories: summary.totalDirectories,
    ...(summary.stoppedReason ? { stoppedReason: summary.stoppedReason } : {}),
    ...(summary.skippedInaccessible
      ? { skippedInaccessible: summary.skippedInaccessible }
      : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf-8')
    );
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { offset?: unknown }).offset === 'number'
    ) {
      const { offset } = parsed as { offset: number };
      return Number.isInteger(offset) && offset >= 0 ? offset : 0;
    }
  } catch {
    // ignore malformed cursor
  }
  return 0;
}

async function handleListDirectory(
  args: z.infer<typeof ListDirectoryInputSchema>,
  signal?: AbortSignal
): Promise<ToolResponse<z.infer<typeof ListDirectoryOutputSchema>>> {
  const dirPath = resolvePathOrRoot(args.path);
  const cursorOffset =
    args.cursor !== undefined ? decodeCursor(args.cursor) : 0;
  const pageSize = args.maxEntries;
  const options: Parameters<typeof listDirectory>[1] = {
    includeHidden: args.includeHidden,
    excludePatterns: args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS,
    sortBy: args.sortBy,
    includeSymlinkTargets: args.includeSymlinkTargets,
    ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
    maxEntries: cursorOffset + pageSize,
    ...(args.pattern !== undefined ? { pattern: args.pattern } : {}),
    ...(signal ? { signal } : {}),
  };
  const result = await listDirectory(dirPath, options);
  const displayEntries =
    cursorOffset > 0 ? result.entries.slice(cursorOffset) : result.entries;
  const nextCursor =
    result.summary.truncated && displayEntries.length > 0
      ? encodeCursor(cursorOffset + displayEntries.length)
      : undefined;
  const displayResult = { ...result, entries: displayEntries };
  return buildToolResponse(
    buildListTextResult(displayResult, nextCursor),
    buildStructuredListResult(displayResult, nextCursor)
  );
}

export function registerListDirectoryTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof ListDirectoryInputSchema>,
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof ListDirectoryOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'ls',
      extra,
      context: { path: args.path ?? '.' },
      run: (signal) => handleListDirectory(args, signal),
      onError: (error) =>
        buildToolErrorResponse(
          error,
          ErrorCode.E_NOT_DIRECTORY,
          args.path ?? '.'
        ),
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    progressMessage: (args) => {
      if (args.path) {
        return `≣ ls: ${path.basename(args.path)}`;
      }
      return '≣ ls';
    },
    completionMessage: (args, result) => {
      const base = args.path ? path.basename(args.path) : '.';
      if (result.isError) return `≣ ls: ${base} • failed`;
      const sc = result.structuredContent;
      if (!sc.ok) return `≣ ls: ${base} • failed`;
      const count = sc.totalEntries ?? 0;
      return `≣ ls: ${base} • ${count} ${count === 1 ? 'entry' : 'entries'}`;
    },
  });

  const validatedHandler = withValidatedArgs(
    ListDirectoryInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      'ls',
      LIST_DIRECTORY_TOOL,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  )
    return;
  server.registerTool(
    'ls',
    withDefaultIcons({ ...LIST_DIRECTORY_TOOL }, options.iconInfo),
    validatedHandler
  );
}
