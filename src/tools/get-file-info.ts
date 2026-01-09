import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { DEFAULT_SEARCH_TIMEOUT_MS } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { getFileInfo } from '../lib/file-operations/file-info.js';
import { createTimedAbortSignal } from '../lib/fs-helpers/abort.js';
import { withToolDiagnostics } from '../lib/observability/diagnostics.js';
import {
  GetFileInfoInputSchema,
  GetFileInfoOutputSchema,
} from '../schemas/index.js';
import {
  buildFileInfoPayload,
  formatFileInfoDetails,
} from './shared/file-info.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
  withToolErrorHandling,
} from './tool-response.js';

type GetFileInfoArgs = z.infer<typeof GetFileInfoInputSchema>;
type GetFileInfoStructuredResult = z.infer<typeof GetFileInfoOutputSchema>;

function buildStructuredResult(
  info: Awaited<ReturnType<typeof getFileInfo>>
): GetFileInfoStructuredResult {
  return {
    ok: true,
    info: buildFileInfoPayload(info),
  };
}

async function handleGetFileInfo(
  {
    path,
  }: {
    path: string;
  },
  signal?: AbortSignal
): Promise<ToolResponse<GetFileInfoStructuredResult>> {
  const options: { signal?: AbortSignal } = {};
  if (signal) {
    options.signal = signal;
  }
  const info = await getFileInfo(path, options);
  const structured = buildStructuredResult(info);
  return buildToolResponse(formatFileInfoDetails(info), structured);
}

const GET_FILE_INFO_TOOL = {
  title: 'Get File Info',
  description:
    'Retrieve detailed metadata about a file or directory without reading contents. ' +
    'Returns: name, path, type, size, timestamps (created/modified/accessed), permissions, ' +
    'MIME type (for files), hidden status, and symlink target (if applicable). ' +
    'Use this to check file properties before reading large files.',
  inputSchema: GetFileInfoInputSchema,
  outputSchema: GetFileInfoOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

export function registerGetFileInfoTool(server: McpServer): void {
  const handler = (
    args: GetFileInfoArgs,
    extra: { signal?: AbortSignal }
  ): Promise<ToolResult<GetFileInfoStructuredResult>> =>
    withToolDiagnostics(
      'stat',
      () =>
        withToolErrorHandling(
          async () => {
            const { signal, cleanup } = createTimedAbortSignal(
              extra.signal,
              DEFAULT_SEARCH_TIMEOUT_MS
            );
            try {
              return await handleGetFileInfo(args, signal);
            } finally {
              cleanup();
            }
          },
          (error) =>
            buildToolErrorResponse(error, ErrorCode.E_NOT_FOUND, args.path)
        ),
      { path: args.path }
    );

  server.registerTool('stat', GET_FILE_INFO_TOOL, handler);
}
