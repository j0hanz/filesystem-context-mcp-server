import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { joinLines } from '../config/formatting.js';
import type { GetMultipleFileInfoResult } from '../config/types.js';
import { DEFAULT_SEARCH_TIMEOUT_MS } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { getMultipleFileInfo } from '../lib/file-operations/get-multiple-file-info.js';
import { createTimedAbortSignal } from '../lib/fs-helpers/abort.js';
import { withToolDiagnostics } from '../lib/observability/diagnostics.js';
import {
  GetMultipleFileInfoInputSchema,
  GetMultipleFileInfoOutputSchema,
} from '../schemas/index.js';
import {
  buildFileInfoPayload,
  formatFileInfoSummary,
} from './shared/file-info.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
  withToolErrorHandling,
} from './tool-response.js';

type GetMultipleFileInfoArgs = z.infer<typeof GetMultipleFileInfoInputSchema>;
type GetMultipleFileInfoStructuredResult = z.infer<
  typeof GetMultipleFileInfoOutputSchema
>;

function buildStructuredResult(
  result: GetMultipleFileInfoResult
): GetMultipleFileInfoStructuredResult {
  return {
    ok: true,
    results: result.results.map((r) => ({
      path: r.path,
      info: r.info ? buildFileInfoPayload(r.info) : undefined,
      error: r.error,
    })),
    summary: {
      total: result.summary.total,
      succeeded: result.summary.succeeded,
      failed: result.summary.failed,
    },
  };
}

function buildTextResult(result: GetMultipleFileInfoResult): string {
  const fileBlocks = result.results.flatMap(formatFileInfoBlock);
  return joinLines([
    `${result.summary.succeeded}/${result.summary.total} files:`,
    ...fileBlocks,
  ]);
}

function formatFileInfoBlock(
  item: GetMultipleFileInfoResult['results'][number]
): string[] {
  if (!item.info) {
    return [`  ${item.path} (error: ${item.error ?? 'unknown'})`];
  }
  return [`  ${formatFileInfoSummary(item.path, item.info)}`];
}

async function handleGetMultipleFileInfo(
  args: GetMultipleFileInfoArgs,
  signal?: AbortSignal
): Promise<ToolResponse<GetMultipleFileInfoStructuredResult>> {
  // Hardcode includeMimeType to true (always want MIME type)
  const options: Parameters<typeof getMultipleFileInfo>[1] = {
    includeMimeType: true,
  };
  if (signal) {
    options.signal = signal;
  }
  const result = await getMultipleFileInfo(args.paths, options);

  return buildToolResponse(
    buildTextResult(result),
    buildStructuredResult(result)
  );
}

const GET_MULTIPLE_FILE_INFO_TOOL = {
  title: 'Get Multiple File Info',
  description:
    'Retrieve detailed metadata about multiple files or directories in a single operation (parallel processing). ' +
    'More efficient than calling stat repeatedly. ' +
    'Individual file errors do not fail the entire operation; each file reports success or error independently. ' +
    'Returns: name, path, type, size, timestamps, permissions, MIME type, and symlink target for each path.',
  inputSchema: GetMultipleFileInfoInputSchema,
  outputSchema: GetMultipleFileInfoOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

export function registerGetMultipleFileInfoTool(server: McpServer): void {
  const handler = (
    args: GetMultipleFileInfoArgs,
    extra: { signal?: AbortSignal }
  ): Promise<ToolResult<GetMultipleFileInfoStructuredResult>> =>
    withToolDiagnostics('stat_many', () =>
      withToolErrorHandling(
        async () => {
          const { signal, cleanup } = createTimedAbortSignal(
            extra.signal,
            DEFAULT_SEARCH_TIMEOUT_MS
          );
          try {
            return await handleGetMultipleFileInfo(args, signal);
          } finally {
            cleanup();
          }
        },
        (error) => buildToolErrorResponse(error, ErrorCode.E_UNKNOWN)
      )
    );

  server.registerTool('stat_many', GET_MULTIPLE_FILE_INFO_TOOL, handler);
}
