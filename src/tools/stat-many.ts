import type { McpServer } from '@modelcontextprotocol/server';

import type { z } from 'zod/v4';

import { DEFAULT_SEARCH_TIMEOUT_MS } from '../lib/constants.js';
import { classifyError, ErrorCode } from '../lib/errors.js';
import { getMultipleFileInfo } from '../lib/file-operations/metadata.js';

import { type FileInfo, formatBytes, joinLines } from '../config.js';
import {
  GetMultipleFileInfoInputSchema,
  GetMultipleFileInfoOutputSchema,
} from '../schemas.js';
import { FILE_READ_ICONS } from './icons.js';
import {
  buildBatchPathContext,
  buildFileInfoPayload,
  buildStructuredError,
  buildToolErrorResponse,
  buildToolResponse,
  createBatchProgressCallbacks,
  executeToolWithDiagnostics,
  READ_ONLY_TOOL_ANNOTATIONS,
  resolveFinalProgressCurrent,
  type ToolContext,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
} from './shared.js';
import { registerStandardTool } from './task-support.js';

export const GET_MULTIPLE_FILE_INFO_TOOL: ToolContract = {
  name: 'stat_many',
  title: 'Get Multiple File Info',
  description:
    'Get metadata for multiple files/directories in one request. ' +
    'Use `tokenEstimate` (size\u00f74) to pre-screen token cost before reading.',
  inputSchema: GetMultipleFileInfoInputSchema,
  outputSchema: GetMultipleFileInfoOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: FILE_READ_ICONS,
  taskSupport: 'optional',
} as const;

function formatFileInfoDetail(info: FileInfo): string {
  const lines = [
    `${info.name} (${info.type})`,
    `  Path: ${info.path}`,
    `  Size: ${formatBytes(info.size)}`,
    `  Modified: ${info.modified.toISOString()}`,
  ];
  if (info.mimeType) lines.push(`  Type: ${info.mimeType}`);
  if (info.symlinkTarget) lines.push(`  Target: ${info.symlinkTarget}`);
  return joinLines(lines);
}

async function handleGetMultipleFileInfo(
  args: z.infer<typeof GetMultipleFileInfoInputSchema>,
  signal?: AbortSignal,
  onProgress?: () => void
): Promise<ToolResponse<z.infer<typeof GetMultipleFileInfoOutputSchema>>> {
  const result = await getMultipleFileInfo(args.paths, {
    includeMimeType: true,
    ...(signal ? { signal } : {}),
    ...(onProgress ? { onProgress } : {}),
  });

  const structuredResults: z.infer<
    typeof GetMultipleFileInfoOutputSchema
  >['results'] = result.results.map((entry) => ({
    path: entry.path,
    info: entry.info ? buildFileInfoPayload(entry.info) : undefined,
    error: entry.error
      ? buildStructuredError(entry.error, ErrorCode.NOT_FOUND, entry.path)
      : undefined,
  }));

  const text = result.results
    .map((entry) => {
      if (entry.error) {
        return `${entry.path}: ${buildStructuredError(entry.error, ErrorCode.NOT_FOUND, entry.path).message}`;
      }
      if (entry.info) {
        return formatFileInfoDetail(entry.info);
      }
      return entry.path;
    })
    .join('\n\n');

  const structured: z.infer<typeof GetMultipleFileInfoOutputSchema> = {
    ok: true,
    results: structuredResults,
    summary: {
      total: result.summary.total,
      succeeded: result.summary.succeeded,
      failed: result.summary.failed,
    },
  };

  return buildToolResponse(text, structured);
}

export function registerGetMultipleFileInfoTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof GetMultipleFileInfoInputSchema>,
    ctx: ToolContext
  ): Promise<ToolResult<z.infer<typeof GetMultipleFileInfoOutputSchema>>> => {
    const primaryPath = args.paths[0] ?? '';
    return executeToolWithDiagnostics({
      toolName: 'stat_many',
      ctx,
      outputSchema: GetMultipleFileInfoOutputSchema,
      timedSignal: { timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS },
      context: { path: primaryPath },
      run: async (signal) => {
        const context = buildBatchPathContext(args.paths);
        const { progress, onItemComplete } = createBatchProgressCallbacks(ctx, {
          toolLabel: GET_MULTIPLE_FILE_INFO_TOOL.title,
          context,
          totalItems: args.paths.length,
          itemVerb: 'done',
        });

        try {
          const result = await handleGetMultipleFileInfo(
            args,
            signal,
            onItemComplete
          );

          const sc = result.structuredContent;
          const total = sc.summary?.total ?? 0;
          const failed = sc.summary?.failed ?? 0;
          const suffix = failed ? `${failed} failed` : 'done';

          const finalCurrent = resolveFinalProgressCurrent(progress, total);
          progress.complete(
            `${GET_MULTIPLE_FILE_INFO_TOOL.title}: ${context} • ${suffix}`,
            finalCurrent
          );
          return result;
        } catch (error) {
          progress.fail(
            `${GET_MULTIPLE_FILE_INFO_TOOL.title}: ${context} • ${classifyError(error)}`
          );
          throw error;
        }
      },
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.NOT_FOUND, primaryPath),
    });
  };

  registerStandardTool(server, GET_MULTIPLE_FILE_INFO_TOOL, handler, options);
}
