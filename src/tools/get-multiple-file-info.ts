import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { formatBytes, joinLines } from '../config/formatting.js';
import type { GetMultipleFileInfoResult } from '../config/types.js';
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
    summary: result.summary,
  };
}

function buildTextResult(result: GetMultipleFileInfoResult): string {
  const fileBlocks = result.results.flatMap(formatFileInfoBlock);
  const summary = `${result.summary.succeeded}/${result.summary.total} ok | ${formatBytes(result.summary.totalSize)}`;
  return joinLines([`File info (${summary}):`, ...fileBlocks]);
}

function formatFileInfoBlock(
  item: GetMultipleFileInfoResult['results'][number]
): string[] {
  if (!item.info) {
    return [`${item.path} [error: ${item.error ?? 'unknown'}]`];
  }
  return [formatFileInfoSummary(item.path, item.info)];
}

async function handleGetMultipleFileInfo(
  args: GetMultipleFileInfoArgs,
  signal?: AbortSignal
): Promise<ToolResponse<GetMultipleFileInfoStructuredResult>> {
  // Hardcode includeMimeType to true (always want MIME type)
  const result = await getMultipleFileInfo(args.paths, {
    includeMimeType: true,
    signal,
  });

  return buildToolResponse(
    buildTextResult(result),
    buildStructuredResult(result)
  );
}

const GET_MULTIPLE_FILE_INFO_TOOL = {
  title: 'Get Multiple File Info',
  description:
    'Retrieve detailed metadata about multiple files or directories in a single operation (parallel processing). ' +
    'More efficient than calling get_file_info repeatedly. ' +
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
    withToolDiagnostics('get_multiple_file_info', () =>
      withToolErrorHandling(
        async () => {
          const { signal, cleanup } = createTimedAbortSignal(
            extra.signal,
            30000
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

  server.registerTool(
    'get_multiple_file_info',
    GET_MULTIPLE_FILE_INFO_TOOL,
    handler
  );
}
