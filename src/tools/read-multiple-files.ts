import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { joinLines } from '../config/formatting.js';
import {
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_TEXT_FILE_SIZE,
} from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { readMultipleFiles } from '../lib/file-operations/read-multiple-files.js';
import { createTimedAbortSignal } from '../lib/fs-helpers/abort.js';
import { withToolDiagnostics } from '../lib/observability/diagnostics.js';
import {
  ReadMultipleFilesInputSchema,
  ReadMultipleFilesOutputSchema,
} from '../schemas/index.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
  withToolErrorHandling,
} from './tool-response.js';

type ReadMultipleArgs = z.infer<typeof ReadMultipleFilesInputSchema>;
type ReadMultipleStructuredResult = z.infer<
  typeof ReadMultipleFilesOutputSchema
>;

function buildStructuredResult(
  results: Awaited<ReturnType<typeof readMultipleFiles>>
): ReadMultipleStructuredResult {
  const succeeded = results.filter((r) => r.content !== undefined).length;
  const failed = results.filter((r) => r.error !== undefined).length;

  return {
    ok: true,
    results: results.map((r) => ({
      path: r.path,
      content: r.content,
      truncated: r.truncated,
      error: r.error,
    })),
    summary: {
      total: results.length,
      succeeded,
      failed,
    },
  };
}

function formatResult(
  result: Awaited<ReturnType<typeof readMultipleFiles>>[number]
): string {
  if (result.content !== undefined) {
    return joinLines([`--- ${result.path} ---`, result.content]);
  }
  return `--- ${result.path} --- (error: ${result.error ?? 'unknown'})`;
}

async function handleReadMultipleFiles(
  args: ReadMultipleArgs,
  signal?: AbortSignal
): Promise<ToolResponse<ReadMultipleStructuredResult>> {
  const options: Parameters<typeof readMultipleFiles>[1] = {
    encoding: 'utf-8',
    maxSize: MAX_TEXT_FILE_SIZE,
    maxTotalSize: 100 * 1024 * 1024,
  };
  if (args.head !== undefined) {
    options.head = args.head;
  }
  if (signal) {
    options.signal = signal;
  }
  const results = await readMultipleFiles(args.paths, options);

  return buildToolResponse(
    joinLines(results.map(formatResult)),
    buildStructuredResult(results)
  );
}

const READ_MULTIPLE_FILES_TOOL = {
  title: 'Read Multiple Files',
  description:
    'Read contents of multiple files in a single operation (parallel processing). ' +
    'More efficient than calling read repeatedly. ' +
    'Individual file errors do not fail the entire operation. ' +
    'Use head parameter to preview the first N lines of each file.',
  inputSchema: ReadMultipleFilesInputSchema,
  outputSchema: ReadMultipleFilesOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

export function registerReadMultipleFilesTool(server: McpServer): void {
  const handler = (
    args: ReadMultipleArgs,
    extra: { signal?: AbortSignal }
  ): Promise<ToolResult<ReadMultipleStructuredResult>> =>
    withToolDiagnostics('read_many', () =>
      withToolErrorHandling(
        async () => {
          const { signal, cleanup } = createTimedAbortSignal(
            extra.signal,
            DEFAULT_SEARCH_TIMEOUT_MS
          );
          try {
            return await handleReadMultipleFiles(args, signal);
          } finally {
            cleanup();
          }
        },
        (error) => buildToolErrorResponse(error, ErrorCode.E_UNKNOWN)
      )
    );

  server.registerTool('read_many', READ_MULTIPLE_FILES_TOOL, handler);
}
