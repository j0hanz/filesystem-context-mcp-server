import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import { z } from 'zod';

import {
  DEFAULT_EXCLUDE_PATTERNS,
  MAX_LIST_ENTRIES,
} from '../lib/constants.js';
import { ErrorCode, McpError } from '../lib/errors.js';
import { listDirectory } from '../lib/file-operations/metadata.js';
import { createBase64JsonCodec } from '../lib/zod-codecs.js';

import { formatOperationSummary, joinLines } from '../config.js';
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
    'List immediate directory contents (non-recursive): name, path, type, size, modified date. ' +
    'Omit path for workspace root. `includeIgnored=true` for node_modules etc. ' +
    'For recursive search, use `find`.',
  inputSchema: ListDirectoryInputSchema,
  outputSchema: ListDirectoryOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  taskSupport: 'optional',
  nuances: ['`pattern` enables filtered recursive traversal up to `maxDepth`.'],
} as const;

interface ListSnapshot {
  entries: Awaited<ReturnType<typeof listDirectory>>['entries'];
  summary: Awaited<ReturnType<typeof listDirectory>>['summary'];
  path: string;
  fingerprint: string;
}

const LIST_CURSOR_TTL_MS =
  parseInt(process.env['FS_CONTEXT_LIST_CURSOR_TTL_MS'] ?? '', 10) ||
  5 * 60 * 1000;
const listSnapshots = new Map<string, ListSnapshot>();
const listSnapshotTimers = new Map<string, NodeJS.Timeout>();
const ListCursorPayloadSchema = z.strictObject({
  snapshotId: z.string().min(1),
  offset: z.int().min(0),
});
const ListCursorCodec = createBase64JsonCodec(ListCursorPayloadSchema);

type ListCursorPayload = z.infer<typeof ListCursorPayloadSchema>;

function buildListFingerprint(
  args: z.infer<typeof ListDirectoryInputSchema>
): string {
  return JSON.stringify({
    path: resolvePathOrRoot(args.path),
    includeHidden: args.includeHidden,
    includeIgnored: args.includeIgnored,
    maxDepth: args.maxDepth,
    sortBy: args.sortBy,
    pattern: args.pattern,
    includeSymlinkTargets: args.includeSymlinkTargets,
  });
}

function deleteListSnapshot(snapshotId: string): void {
  listSnapshots.delete(snapshotId);
  const timer = listSnapshotTimers.get(snapshotId);
  if (timer) {
    clearTimeout(timer);
    listSnapshotTimers.delete(snapshotId);
  }
}

function storeListSnapshot(snapshot: ListSnapshot): string {
  const snapshotId = randomUUID();
  listSnapshots.set(snapshotId, snapshot);
  const timer = setTimeout(() => {
    deleteListSnapshot(snapshotId);
  }, LIST_CURSOR_TTL_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  listSnapshotTimers.set(snapshotId, timer);
  return snapshotId;
}

function encodeListCursor(payload: ListCursorPayload): string {
  return z.encode(ListCursorCodec, payload);
}

function decodeListCursor(cursor: string): ListCursorPayload {
  try {
    return ListCursorCodec.parse(cursor);
  } catch {
    // fall through to throw
  }

  throw new McpError(ErrorCode.INVALID_INPUT, 'Invalid or expired cursor.');
}

function resolveNextListCursor(
  snapshotId: string | undefined,
  offset: number,
  pageSize: number,
  totalEntries: number
): string | undefined {
  if (!snapshotId) return undefined;
  const nextOffset = offset + pageSize;
  if (nextOffset >= totalEntries) {
    deleteListSnapshot(snapshotId);
    return undefined;
  }
  return encodeListCursor({ snapshotId, offset: nextOffset });
}

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

async function handleListDirectory(
  args: z.infer<typeof ListDirectoryInputSchema>,
  signal?: AbortSignal
): Promise<ToolResponse<z.infer<typeof ListDirectoryOutputSchema>>> {
  const dirPath = resolvePathOrRoot(args.path);
  const pageSize = args.maxEntries;
  const options: Parameters<typeof listDirectory>[1] = {
    includeHidden: args.includeHidden,
    excludePatterns: args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS,
    sortBy: args.sortBy,
    includeSymlinkTargets: args.includeSymlinkTargets,
    ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
    maxEntries: MAX_LIST_ENTRIES,
    ...(args.pattern !== undefined ? { pattern: args.pattern } : {}),
    ...(signal ? { signal } : {}),
  };
  const fingerprint = buildListFingerprint(args);

  let result: Awaited<ReturnType<typeof listDirectory>>;
  let cursorOffset = 0;
  let snapshotId: string | undefined;

  if (args.cursor) {
    const cursor = decodeListCursor(args.cursor);
    const snapshot = listSnapshots.get(cursor.snapshotId);
    if (snapshot?.fingerprint !== fingerprint) {
      throw new McpError(ErrorCode.INVALID_INPUT, 'Invalid or expired cursor.');
    }

    const { offset, snapshotId: storedSnapshotId } = cursor;
    cursorOffset = offset;
    snapshotId = storedSnapshotId;
    result = {
      path: snapshot.path,
      entries: snapshot.entries,
      summary: snapshot.summary,
    };
  } else {
    result = await listDirectory(dirPath, options);
  }

  const displayEntries = result.entries.slice(
    cursorOffset,
    cursorOffset + pageSize
  );
  if (!args.cursor && displayEntries.length < result.entries.length) {
    snapshotId = storeListSnapshot({
      path: result.path,
      entries: result.entries,
      summary: result.summary,
      fingerprint,
    });
  }

  const nextCursor = resolveNextListCursor(
    snapshotId,
    cursorOffset,
    displayEntries.length,
    result.entries.length
  );
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
      outputSchema: ListDirectoryOutputSchema,
      context: { path: args.path ?? '.' },
      run: (signal) => handleListDirectory(args, signal),
      onError: (error) =>
        buildToolErrorResponse(
          error,
          ErrorCode.NOT_DIRECTORY,
          args.path ?? '.'
        ),
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    progressMessage: (args) => `≣ ls: ${args.path ? basename(args.path) : '.'}`,
    completionMessage: (args, result) => {
      const base = args.path ? basename(args.path) : '.';
      if (result.isError) return `≣ ls: ${base} • failed`;
      const sc = result.structuredContent;
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
