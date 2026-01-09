import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import {
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_TEXT_FILE_SIZE,
} from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { createTimedAbortSignal } from '../lib/fs-helpers/abort.js';
import { readFile } from '../lib/fs-helpers/readers/read-file.js';
import { withToolDiagnostics } from '../lib/observability/diagnostics.js';
import { ReadFileInputSchema, ReadFileOutputSchema } from '../schemas/index.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
  withToolErrorHandling,
} from './tool-response.js';

type ReadFileArgs = z.infer<typeof ReadFileInputSchema>;
type ReadFileStructuredResult = z.infer<typeof ReadFileOutputSchema>;

function buildStructuredReadResult(
  result: Awaited<ReturnType<typeof readFile>>,
  args: ReadFileArgs
): ReadFileStructuredResult {
  return {
    ok: true,
    path: args.path,
    content: result.content,
    truncated: result.truncated,
    totalLines: result.totalLines,
  };
}

async function handleReadFile(
  args: ReadFileArgs,
  signal?: AbortSignal
): Promise<ToolResponse<ReadFileStructuredResult>> {
  const options: Parameters<typeof readFile>[1] = {
    encoding: 'utf-8',
    maxSize: MAX_TEXT_FILE_SIZE,
    skipBinary: true,
  };
  if (args.head !== undefined) {
    options.head = args.head;
  }
  if (signal) {
    options.signal = signal;
  }
  const result = await readFile(args.path, options);

  return buildToolResponse(
    result.content,
    buildStructuredReadResult(result, args)
  );
}

const READ_FILE_TOOL = {
  title: 'Read File',
  description:
    'Read the text contents of a file. ' +
    'Use head parameter to preview the first N lines of large files. ' +
    'For multiple files, use read_many for efficiency.',
  inputSchema: ReadFileInputSchema,
  outputSchema: ReadFileOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

export function registerReadFileTool(server: McpServer): void {
  const handler = (
    args: ReadFileArgs,
    extra: { signal?: AbortSignal }
  ): Promise<ToolResult<ReadFileStructuredResult>> =>
    withToolDiagnostics(
      'read',
      () =>
        withToolErrorHandling(
          async () => {
            const { signal, cleanup } = createTimedAbortSignal(
              extra.signal,
              DEFAULT_SEARCH_TIMEOUT_MS
            );
            try {
              return await handleReadFile(args, signal);
            } finally {
              cleanup();
            }
          },
          (error) =>
            buildToolErrorResponse(error, ErrorCode.E_NOT_FILE, args.path)
        ),
      { path: args.path }
    );

  server.registerTool('read', READ_FILE_TOOL, handler);
}
