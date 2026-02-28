import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { formatBytes, joinLines } from '../config.js';
import type { FileInfo } from '../config.js';
import { DEFAULT_SEARCH_TIMEOUT_MS } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { getMultipleFileInfo } from '../lib/file-operations/file-info.js';
import {
  GetMultipleFileInfoInputSchema,
  GetMultipleFileInfoOutputSchema,
} from '../schemas.js';
import {
  buildBatchPathContext,
  buildFileInfoPayload,
  buildToolErrorResponse,
  buildToolResponse,
  createToolProgressSession,
  executeToolWithDiagnostics,
  READ_ONLY_TOOL_ANNOTATIONS,
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

export const GET_MULTIPLE_FILE_INFO_TOOL: ToolContract = {
  name: 'stat_many',
  title: 'Get Multiple File Info',
  description:
    'Get metadata (including tokenEstimate) for multiple files or directories in one request. Use tokenEstimate (size÷4) to pre-screen token cost before reading.',
  inputSchema: GetMultipleFileInfoInputSchema,
  outputSchema: GetMultipleFileInfoOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  taskSupport: 'optional',
  nuances: ['Use before read/search when file size/type uncertainty exists.'],
} as const;

function buildStatManyCompletionSuffix(
  summary: z.infer<typeof GetMultipleFileInfoOutputSchema>['summary']
): string {
  const total = summary?.total ?? 0;
  const failed = summary?.failed ?? 0;
  const succeeded = summary?.succeeded ?? 0;
  if (failed) {
    return `${succeeded}/${total} OK, ${failed} failed`;
  }
  return `${total} OK`;
}

function createStatManyProgressCallbacks(
  extra: ToolExtra,
  context: string,
  totalPaths: number
): {
  progress: ReturnType<typeof createToolProgressSession>;
  onProgress: () => void;
} {
  const progress = createToolProgressSession(extra, `🕮 stat_many: ${context}`);
  const onProgress = (): void => {
    progress.increment(
      (current) => `🕮 stat_many: ${context} [${current}/${totalPaths} scanned]`
    );
  };
  return { progress, onProgress };
}

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
  >['results'] = [];
  const textBlocks: string[] = [];
  for (const entry of result.results) {
    structuredResults.push({
      path: entry.path,
      info: entry.info ? buildFileInfoPayload(entry.info) : undefined,
      error: entry.error,
    });
    if (entry.error) {
      textBlocks.push(`${entry.path}: ${entry.error}`);
    } else if (entry.info) {
      textBlocks.push(formatFileInfoDetail(entry.info));
    } else {
      textBlocks.push(entry.path);
    }
  }

  const structured: z.infer<typeof GetMultipleFileInfoOutputSchema> = {
    ok: true,
    results: structuredResults,
    summary: {
      total: result.summary.total,
      succeeded: result.summary.succeeded,
      failed: result.summary.failed,
    },
  };

  const text = textBlocks.join('\n\n');

  return buildToolResponse(text, structured);
}

export function registerGetMultipleFileInfoTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof GetMultipleFileInfoInputSchema>,
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof GetMultipleFileInfoOutputSchema>>> => {
    const primaryPath = args.paths[0] ?? '';
    return executeToolWithDiagnostics({
      toolName: 'stat_many',
      extra,
      timedSignal: { timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS },
      context: { path: primaryPath },
      run: async (signal) => {
        const context = buildBatchPathContext(args.paths);
        const { progress, onProgress } = createStatManyProgressCallbacks(
          extra,
          context,
          args.paths.length
        );

        try {
          const result = await handleGetMultipleFileInfo(
            args,
            signal,
            onProgress
          );

          const sc = result.structuredContent;
          const suffix = buildStatManyCompletionSuffix(sc.summary);
          const total = sc.summary?.total ?? 0;

          const finalCurrent = Math.max(total, progress.getCurrent() + 1);
          progress.complete(
            `🕮 stat_many: ${context} • ${suffix}`,
            finalCurrent
          );
          return result;
        } catch (error) {
          progress.fail(`🕮 stat_many: ${context} • failed`);
          throw error;
        }
      },
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.E_NOT_FOUND, primaryPath),
    });
  };

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
  });

  const validatedHandler = withValidatedArgs(
    GetMultipleFileInfoInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      'stat_many',
      GET_MULTIPLE_FILE_INFO_TOOL,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  )
    return;
  server.registerTool(
    'stat_many',
    withDefaultIcons({ ...GET_MULTIPLE_FILE_INFO_TOOL }, options.iconInfo),
    validatedHandler
  );
}
