import type { McpServer } from '@modelcontextprotocol/server';

import { basename, relative } from 'node:path';

import type { z } from 'zod';

import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from '../lib/constants.js';
import { classifyError, ErrorCode } from '../lib/errors.js';
import { searchFiles } from '../lib/file-operations/search.js';

import { formatOperationSummary, joinLines } from '../config.js';
import { SearchFilesInputSchema, SearchFilesOutputSchema } from '../schemas.js';
import { DIRECTORY_ICONS } from './icons.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  createProgressReporter,
  decodeOffsetCursor,
  encodeOffsetCursor,
  executeToolWithDiagnostics,
  notifyProgress,
  READ_ONLY_TOOL_ANNOTATIONS,
  resolvePathOrRoot,
  type ToolContext,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
  truncateProgressPattern,
} from './shared.js';
import { registerStandardTool } from './task-support.js';

export const SEARCH_FILES_TOOL: ToolContract = {
  name: 'find',
  title: 'Find Files',
  description:
    'Find files by glob pattern (e.g. `**/*.ts`). Returns matching files with metadata. ' +
    'For content search, use `grep`. For bulk edits, pass the same glob to `search_and_replace`.',
  inputSchema: SearchFilesInputSchema,
  outputSchema: SearchFilesOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: DIRECTORY_ICONS,
  nuances: ['Respects `.gitignore` unless `includeIgnored=true`.'],
  taskSupport: 'optional',
} as const;

function buildTruncatedReason(summary: {
  truncated: boolean;
  stoppedReason?: string;
  filesScanned: number;
  matched: number;
}): string | undefined {
  if (!summary.truncated) return undefined;
  if (summary.stoppedReason === 'timeout') return 'timeout';
  if (summary.stoppedReason === 'maxFiles')
    return `max files (${summary.filesScanned})`;
  return `max results (${summary.matched})`;
}

function buildRelativeResults(
  basePath: string,
  displayResults: readonly { path: string; size?: number; modified?: Date }[]
): NonNullable<z.infer<typeof SearchFilesOutputSchema>['results']> {
  const relativeResults: NonNullable<
    z.infer<typeof SearchFilesOutputSchema>['results']
  > = [];
  for (const entry of displayResults) {
    relativeResults.push({
      path: relative(basePath, entry.path),
      size: entry.size,
      modified: entry.modified?.toISOString(),
    });
  }
  return relativeResults;
}

function computeNextCursor(
  summary: { truncated: boolean },
  displayResultsCount: number,
  cursorOffset: number
): string | undefined {
  if (summary.truncated && displayResultsCount > 0) {
    return encodeOffsetCursor(cursorOffset + displayResultsCount);
  }
  return undefined;
}

function applySummaryFields(
  structured: z.infer<typeof SearchFilesOutputSchema>,
  summary: {
    truncated: boolean;
    skippedInaccessible: number;
    stoppedReason?: 'timeout' | 'maxResults' | 'maxFiles';
  },
  nextCursor?: string
): void {
  if (summary.truncated) structured.truncated = true;
  if (summary.skippedInaccessible)
    structured.skippedInaccessible = summary.skippedInaccessible;
  if (summary.stoppedReason) structured.stoppedReason = summary.stoppedReason;
  if (nextCursor !== undefined) structured.nextCursor = nextCursor;
}

async function handleSearchFiles(
  args: z.infer<typeof SearchFilesInputSchema>,
  signal?: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<ToolResponse<z.infer<typeof SearchFilesOutputSchema>>> {
  const basePath = resolvePathOrRoot(args.path);
  const excludePatterns = args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS;
  const cursorOffset =
    args.cursor !== undefined ? decodeOffsetCursor(args.cursor) : 0;
  const pageSize = args.maxResults;
  const fetchMax = cursorOffset + pageSize;
  const searchOptions: Parameters<typeof searchFiles>[3] = {
    maxResults: fetchMax,
    includeHidden: args.includeHidden,
    sortBy: args.sortBy,
    respectGitignore: !args.includeIgnored,
  };
  if (args.maxDepth !== undefined) searchOptions.maxDepth = args.maxDepth;
  if (onProgress) searchOptions.onProgress = onProgress;
  if (signal) searchOptions.signal = signal;
  const result = await searchFiles(
    basePath,
    args.pattern,
    excludePatterns,
    searchOptions
  );
  const allResults = result.results;
  let displayResults = allResults;
  if (cursorOffset > 0) displayResults = allResults.slice(cursorOffset);

  const nextCursor = computeNextCursor(
    result.summary,
    displayResults.length,
    cursorOffset
  );
  const relativeResults = buildRelativeResults(result.basePath, displayResults);
  const structured: z.infer<typeof SearchFilesOutputSchema> = {
    ok: true,
    root: basePath,
    results: relativeResults,
    totalMatches: result.summary.matched,
    filesScanned: result.summary.filesScanned,
  };
  applySummaryFields(structured, result.summary, nextCursor);

  const truncatedReason = buildTruncatedReason(result.summary);

  const summaryOptions: Parameters<typeof formatOperationSummary>[0] = {
    truncated: result.summary.truncated,
  };
  if (truncatedReason) summaryOptions.truncatedReason = truncatedReason;

  const textLines: string[] = [];
  if (relativeResults.length === 0) {
    textLines.push('No matches');
  } else {
    textLines.push(`Found ${relativeResults.length}:`);
    for (const entry of relativeResults) {
      textLines.push(`  ${entry.path}`);
    }
  }

  let text = joinLines(textLines) + formatOperationSummary(summaryOptions);
  if (nextCursor) {
    text += `\n[Next page available. Use cursor: "${nextCursor}"]`;
  }
  return buildToolResponse(text, structured);
}

export function registerSearchFilesTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof SearchFilesInputSchema>,
    ctx: ToolContext
  ): Promise<ToolResult<z.infer<typeof SearchFilesOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'find',
      ctx,
      outputSchema: SearchFilesOutputSchema,
      timedSignal: { timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS },
      context: { path: args.path ?? '.' },
      run: async (signal) => {
        const rawScopeLabel = args.path ? basename(args.path) : '.';
        const scopeLabel = rawScopeLabel || '.';
        const { pattern } = args;
        const truncatedPattern = truncateProgressPattern(pattern);
        const context = `${truncatedPattern} in ${scopeLabel}`;
        let progressCursor = 0;
        notifyProgress(ctx, {
          current: 0,
          message: `${SEARCH_FILES_TOOL.title}: ${truncatedPattern}`,
        });

        const baseReporter = createProgressReporter(ctx);
        const progressWithMessage = ({
          current,
          total,
        }: {
          total?: number;
          current: number;
        }): void => {
          if (current > progressCursor) progressCursor = current;
          baseReporter({
            current,
            ...(total !== undefined ? { total } : {}),
            message: `${SEARCH_FILES_TOOL.title}: ${truncatedPattern} [${current} files]`,
          });
        };

        try {
          const result = await handleSearchFiles(
            args,
            signal,
            progressWithMessage
          );
          const sc = result.structuredContent;
          const { totalMatches = 0, stoppedReason } = sc;

          let suffix: string;
          if (totalMatches === 0) {
            suffix = 'No matches';
          } else {
            suffix = `${totalMatches} ${totalMatches === 1 ? 'match' : 'matches'}`;
            if (stoppedReason === 'timeout') {
              suffix += ' [timeout]';
            } else if (stoppedReason === 'maxResults') {
              suffix += ' [max results]';
            } else if (stoppedReason === 'maxFiles') {
              suffix += ' [max files]';
            }
          }

          const finalCurrent = Math.max(
            (sc.filesScanned ?? 0) + 1,
            progressCursor + 1
          );
          notifyProgress(ctx, {
            current: finalCurrent,
            total: finalCurrent,
            message: `${SEARCH_FILES_TOOL.title}: ${context} • ${suffix}`,
          });
          return result;
        } catch (error) {
          const finalCurrent = Math.max(progressCursor + 1, 1);
          notifyProgress(ctx, {
            current: finalCurrent,
            total: finalCurrent,
            message: `${SEARCH_FILES_TOOL.title}: ${context} • ${classifyError(error)}`,
          });
          throw error;
        }
      },
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.UNKNOWN, args.path),
    });

  registerStandardTool(server, SEARCH_FILES_TOOL, handler, options);
}
