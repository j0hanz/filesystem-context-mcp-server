import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { formatOperationSummary, joinLines } from '../config.js';
import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { searchFiles } from '../lib/file-operations/search-files.js';
import { SearchFilesInputSchema, SearchFilesOutputSchema } from '../schemas.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  createProgressReporter,
  executeToolWithDiagnostics,
  notifyProgress,
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

export const SEARCH_FILES_TOOL: ToolContract = {
  name: 'find',
  title: 'Find Files',
  description:
    'Find files by glob pattern (e.g., **/*.ts). ' +
    'Returns a list of matching files with metadata. ' +
    'For text search inside files, use grep. ' +
    'To bulk-edit the matched files, pass the same glob pattern to search_and_replace.',
  inputSchema: SearchFilesInputSchema,
  outputSchema: SearchFilesOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  nuances: [
    'Respects `.gitignore` unless `includeIgnored=true`.',
    'Returns relative paths plus metadata; may truncate.',
  ],
  taskSupport: 'optional',
} as const;

async function handleSearchFiles(
  args: z.infer<typeof SearchFilesInputSchema>,
  signal?: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<ToolResponse<z.infer<typeof SearchFilesOutputSchema>>> {
  const basePath = resolvePathOrRoot(args.path);
  const excludePatterns = args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS;
  const cursorOffset =
    args.cursor !== undefined ? decodeCursor(args.cursor) : 0;
  const pageSize = args.maxResults;
  const fetchMax = cursorOffset + pageSize;
  const searchOptions: Parameters<typeof searchFiles>[3] = {
    maxResults: fetchMax,
    includeHidden: args.includeHidden,
    sortBy: args.sortBy,
    respectGitignore: !args.includeIgnored,
    ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
    ...(onProgress ? { onProgress } : {}),
    ...(signal ? { signal } : {}),
  };
  const result = await searchFiles(
    basePath,
    args.pattern,
    excludePatterns,
    searchOptions
  );
  const allResults = result.results;
  const displayResults =
    cursorOffset > 0 ? allResults.slice(cursorOffset) : allResults;
  const nextCursor =
    result.summary.truncated && displayResults.length > 0
      ? encodeCursor(cursorOffset + displayResults.length)
      : undefined;
  const relativeResults: z.infer<typeof SearchFilesOutputSchema>['results'] =
    [];
  for (const entry of displayResults) {
    relativeResults.push({
      path: path.relative(result.basePath, entry.path),
      size: entry.size,
      modified: entry.modified?.toISOString(),
    });
  }
  const structured: z.infer<typeof SearchFilesOutputSchema> = {
    ok: true,
    root: basePath,
    pattern: args.pattern,
    results: relativeResults,
    totalMatches: result.summary.matched,
    filesScanned: result.summary.filesScanned,
    ...(result.summary.truncated
      ? { truncated: result.summary.truncated }
      : {}),
    ...(result.summary.skippedInaccessible
      ? { skippedInaccessible: result.summary.skippedInaccessible }
      : {}),
    ...(result.summary.stoppedReason
      ? { stoppedReason: result.summary.stoppedReason }
      : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };

  let truncatedReason: string | undefined;
  if (result.summary.truncated) {
    if (result.summary.stoppedReason === 'timeout') {
      truncatedReason = 'timeout';
    } else if (result.summary.stoppedReason === 'maxFiles') {
      truncatedReason = `max files (${result.summary.filesScanned})`;
    } else {
      truncatedReason = `max results (${result.summary.matched})`;
    }
  }

  const summaryOptions: Parameters<typeof formatOperationSummary>[0] = {
    truncated: result.summary.truncated,
    ...(truncatedReason ? { truncatedReason } : {}),
  };

  const textLines: string[] = [];
  if (relativeResults.length === 0) {
    textLines.push('No matches');
  } else {
    textLines.push(`Found ${relativeResults.length}:`);
    for (const entry of relativeResults) {
      textLines.push(`  ${entry.path}`);
    }
  }

  const text = joinLines(textLines) + formatOperationSummary(summaryOptions);
  return buildToolResponse(text, structured);
}

export function registerSearchFilesTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof SearchFilesInputSchema>,
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof SearchFilesOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'find',
      extra,
      timedSignal: { timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS },
      context: { path: args.path ?? '.' },
      run: async (signal) => {
        const rawScopeLabel = args.path ? path.basename(args.path) : '.';
        const scopeLabel = rawScopeLabel || '.';
        const { pattern } = args;
        const context = `${pattern} in ${scopeLabel}`;
        let progressCursor = 0;
        notifyProgress(extra, {
          current: 0,
          message: `🔎︎ find: ${context}`,
        });

        const baseReporter = createProgressReporter(extra);
        const progressWithMessage = ({
          current,
          total,
        }: {
          total?: number;
          current: number;
        }): void => {
          if (current > progressCursor) progressCursor = current;
          const fileWord = current === 1 ? 'file' : 'files';
          baseReporter({
            current,
            ...(total !== undefined ? { total } : {}),
            message: `🔎︎ find: ${pattern} [${current} ${fileWord} scanned]`,
          });
        };

        try {
          const result = await handleSearchFiles(
            args,
            signal,
            progressWithMessage
          );
          const sc = result.structuredContent;
          const count = sc.ok ? (sc.totalMatches ?? 0) : 0;
          const stoppedReason = sc.ok ? sc.stoppedReason : undefined;

          let suffix: string;
          if (count === 0) {
            suffix = `No matches in ${scopeLabel}`;
          } else {
            suffix = `${count} ${count === 1 ? 'match' : 'matches'}`;
            if (stoppedReason === 'timeout') {
              suffix += ' [stopped — timeout]';
            } else if (stoppedReason === 'maxResults') {
              suffix += ' [truncated — max results]';
            } else if (stoppedReason === 'maxFiles') {
              suffix += ' [truncated — max files]';
            }
          }

          const finalCurrent = Math.max(
            (sc.filesScanned ?? 0) + 1,
            progressCursor + 1
          );
          notifyProgress(extra, {
            current: finalCurrent,
            total: finalCurrent,
            message: `🔎︎ find: ${context} • ${suffix}`,
          });
          return result;
        } catch (error) {
          const finalCurrent = Math.max(progressCursor + 1, 1);
          notifyProgress(extra, {
            current: finalCurrent,
            total: finalCurrent,
            message: `🔎︎ find: ${context} • failed`,
          });
          throw error;
        }
      },
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.E_UNKNOWN, args.path),
    });

  const { isInitialized } = options;

  const wrappedHandler = wrapToolHandler(handler, {
    guard: isInitialized,
  });

  const validatedHandler = withValidatedArgs(
    SearchFilesInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      'find',
      SEARCH_FILES_TOOL,
      validatedHandler,
      options.iconInfo,
      isInitialized
    )
  )
    return;
  server.registerTool(
    'find',
    withDefaultIcons({ ...SEARCH_FILES_TOOL }, options.iconInfo),
    validatedHandler
  );
}
