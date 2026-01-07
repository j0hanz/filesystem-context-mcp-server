import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { joinLines } from '../config/formatting.js';
import { MAX_TEXT_FILE_SIZE } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { readMultipleFiles } from '../lib/file-operations/read-multiple-files.js';
import { createTimedAbortSignal } from '../lib/fs-helpers/abort.js';
import { assertLineRangeOptions } from '../lib/line-range.js';
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
type ReadMultipleOptions = NonNullable<Parameters<typeof readMultipleFiles>[1]>;
type EffectiveReadMultipleOptions = Omit<ReadMultipleOptions, 'signal'>;

function buildStructuredResult(
  results: Awaited<ReturnType<typeof readMultipleFiles>>,
  effectiveOptions: EffectiveReadMultipleOptions
): ReadMultipleStructuredResult {
  const succeeded = results.filter((r) => r.content !== undefined).length;
  const failed = results.filter((r) => r.error !== undefined).length;

  return {
    ok: true,
    results,
    summary: {
      total: results.length,
      succeeded,
      failed,
    },
    effectiveOptions,
  };
}

function formatReadMultipleResult(
  result: Awaited<ReturnType<typeof readMultipleFiles>>[number]
): string {
  return result.content !== undefined
    ? formatSuccessResult(result)
    : formatErrorResult(result.path, result.error);
}

function formatSuccessResult(
  result: Awaited<ReturnType<typeof readMultipleFiles>>[number]
): string {
  const footer = buildReadMultipleFooter(result);
  const contentBlock = footer.length
    ? joinLines([result.content ?? '', ...footer])
    : (result.content ?? '');
  return joinLines([`=== ${result.path} ===`, contentBlock]);
}

function formatErrorResult(path: string, error: string | undefined): string {
  return joinLines([`=== ${path} ===`, `[Error: ${error ?? 'Unknown error'}]`]);
}

type ReadMultipleResult = Awaited<ReturnType<typeof readMultipleFiles>>[number];

function buildReadMultipleFooter(result: ReadMultipleResult): string[] {
  const notes: string[] = [];
  if (result.truncated === true) {
    notes.push(
      result.totalLines !== undefined
        ? `[Truncated. Total lines: ${result.totalLines}]`
        : '[Truncated]'
    );
  }

  switch (result.readMode) {
    case 'lineRange':
      if (result.lineStart !== undefined && result.lineEnd !== undefined) {
        notes.push(`Showing lines ${result.lineStart}-${result.lineEnd}`);
      }
      break;
    case 'head':
      if (result.head !== undefined) {
        notes.push(`Showing first ${String(result.head)} lines`);
      }
      break;
    case 'tail':
      if (result.tail !== undefined) {
        notes.push(`Showing last ${String(result.tail)} lines`);
      }
      break;
    default:
      break;
  }
  return notes;
}

async function handleReadMultipleFiles(
  args: ReadMultipleArgs,
  signal?: AbortSignal
): Promise<ToolResponse<ReadMultipleStructuredResult>> {
  const pathLabel = args.paths[0] ?? '<paths>';
  assertLineRangeOptions(
    {
      lineStart: args.lineStart,
      lineEnd: args.lineEnd,
      head: args.head,
      tail: args.tail,
    },
    pathLabel
  );
  const effectiveOptions: EffectiveReadMultipleOptions = {
    encoding: 'utf-8',
    maxSize: MAX_TEXT_FILE_SIZE,
    maxTotalSize: 100 * 1024 * 1024,
    head: args.head,
    tail: args.tail,
    lineStart: args.lineStart,
    lineEnd: args.lineEnd,
  };
  const results = await readMultipleFiles(args.paths, {
    ...effectiveOptions,
    signal,
  });

  return buildToolResponse(
    joinLines(results.map(formatReadMultipleResult)),
    buildStructuredResult(results, effectiveOptions)
  );
}

const READ_MULTIPLE_FILES_TOOL = {
  title: 'Read Multiple Files',
  description:
    'Read contents of multiple files in a single operation (parallel processing). ' +
    'More efficient than calling read_file repeatedly. ' +
    'Individual file errors do not fail the entire operation; each file reports success or error independently. ' +
    'Supports head/tail or lineStart/lineEnd for reading partial content from all files (mutually exclusive).',
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
    withToolDiagnostics('read_multiple_files', () =>
      withToolErrorHandling(
        async () => {
          const { signal, cleanup } = createTimedAbortSignal(
            extra.signal,
            30000
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

  server.registerTool('read_multiple_files', READ_MULTIPLE_FILES_TOOL, handler);
}
