import type { z } from 'zod/v4';

import { DEFAULT_SEARCH_TIMEOUT_MS } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { getMultipleFileInfo } from '../lib/file-operations/metadata.js';
import { StatManyInputSchema } from '../schemas/inputs.js';
import { StatManyOutputSchema } from '../schemas/outputs.js';

import { type FileInfo, formatBytes, joinLines } from '../config.js';
import { defineTool } from './define-tool.js';
import { FILE_READ_ICONS } from './icons.js';
import {
  buildBatchPathContext,
  buildFileInfoPayload,
  buildStructuredError,
  buildToolResponse,
  completeProgressSession,
  createBatchProgressCallbacks,
  READ_ONLY_TOOL_ANNOTATIONS,
  resolveFinalProgressCurrent,
  type ToolContract,
} from './shared.js';

const GET_MULTIPLE_FILE_INFO_TOOL: ToolContract = {
  name: 'stat_many',
  title: 'Get Multiple File Info',
  description:
    'Get metadata for multiple files/directories in one request. ' +
    'Use `tokenEstimate` (size\u00f74) to pre-screen token cost before reading.',
  inputSchema: StatManyInputSchema,
  outputSchema: StatManyOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: FILE_READ_ICONS,
  taskSupport: 'optional',
  defaultTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
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
  args: z.infer<typeof StatManyInputSchema>,
  signal?: AbortSignal,
  onProgress?: () => void
): Promise<{ text: string; structured: z.infer<typeof StatManyOutputSchema> }> {
  const result = await getMultipleFileInfo(args.paths, {
    includeMimeType: true,
    ...(signal !== undefined ? { signal } : {}),
    ...(onProgress !== undefined ? { onProgress } : {}),
  });

  const structuredResults: z.infer<typeof StatManyOutputSchema>['results'] =
    result.results.map((entry) => ({
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

  const structured: z.infer<typeof StatManyOutputSchema> = {
    ok: true,
    results: structuredResults,
    summary: {
      total: result.summary.total,
      succeeded: result.summary.succeeded,
      failed: result.summary.failed,
    },
  };

  return { text, structured };
}

export const GET_MULTIPLE_FILE_INFO = defineTool<
  z.infer<typeof StatManyInputSchema>,
  z.infer<typeof StatManyOutputSchema>
>({
  contract: GET_MULTIPLE_FILE_INFO_TOOL,
  run: async (args, ctx) => {
    const context = buildBatchPathContext(args.paths);
    const label = `${GET_MULTIPLE_FILE_INFO_TOOL.title}: ${context}`;
    const { progress, onItemComplete } = createBatchProgressCallbacks(ctx, {
      toolLabel: GET_MULTIPLE_FILE_INFO_TOOL.title,
      context,
      totalItems: args.paths.length,
      itemVerb: 'done',
    });

    const result = await completeProgressSession(progress, label, async () => {
      const { text, structured } = await handleGetMultipleFileInfo(
        args,
        ctx.signal,
        onItemComplete
      );
      const total = structured.summary.total;
      const failed = structured.summary.failed;
      const suffix = failed ? `${failed} failed` : 'done';
      const finalCurrent = resolveFinalProgressCurrent(progress, total);

      return {
        value: buildToolResponse(text, structured),
        suffix,
        finalCurrent,
      };
    });

    return result;
  },
  progressMessage: () => GET_MULTIPLE_FILE_INFO_TOOL.title,
  completionMessage: (_args, result) => {
    if (result.isError)
      return `${GET_MULTIPLE_FILE_INFO_TOOL.title} • ${result.errorCode}`;
    const sc = result.structuredContent;
    const total = sc.summary.total;
    const failed = sc.summary.failed;
    const suffix = failed ? ` • ${failed} failed` : '';
    return `${GET_MULTIPLE_FILE_INFO_TOOL.title} • ${total} ${total === 1 ? 'file' : 'files'}${suffix}`;
  },
  defaultErrorCode: ErrorCode.NOT_FOUND,
});
