import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { joinLines } from '../config/formatting.js';
import { MAX_TEXT_FILE_SIZE } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { readMultipleFiles } from '../lib/file-operations.js';
import { createTimedAbortSignal } from '../lib/fs-helpers.js';
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

const READ_MULTIPLE_TIMEOUT_MS = 30000;

type ReadMultipleArgs = z.infer<typeof ReadMultipleFilesInputSchema>;
type ReadMultipleStructuredResult = z.infer<
  typeof ReadMultipleFilesOutputSchema
>;

function buildStructuredResult(
  results: Awaited<ReturnType<typeof readMultipleFiles>>,
  effectiveOptions: {
    encoding: BufferEncoding;
    maxSize: number;
    maxTotalSize: number;
    head?: number;
    tail?: number;
    lineStart?: number;
    lineEnd?: number;
  }
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

function buildTextResult(
  results: Awaited<ReturnType<typeof readMultipleFiles>>
): string {
  return joinLines(results.map(formatReadMultipleResult));
}

function formatReadMultipleResult(
  result: Awaited<ReturnType<typeof readMultipleFiles>>[number]
): string {
  if (result.content !== undefined) {
    const note = buildReadMultipleNote(result);
    const rangeNote = buildReadMultipleRangeNote(result);
    const footer = [rangeNote, note].filter((value): value is string =>
      Boolean(value)
    );
    const contentBlock = footer.length
      ? joinLines([result.content, ...footer])
      : result.content;
    return joinLines([`=== ${result.path} ===`, contentBlock]);
  }
  return joinLines([
    `=== ${result.path} ===`,
    `[Error: ${result.error ?? 'Unknown error'}]`,
  ]);
}

function buildReadMultipleNote(
  result: Awaited<ReturnType<typeof readMultipleFiles>>[number]
): string {
  if (result.truncated !== true) return '';
  if (result.totalLines !== undefined) {
    return `[Truncated. Total lines: ${result.totalLines}]`;
  }
  return '[Truncated]';
}

type ReadMultipleResult = Awaited<ReturnType<typeof readMultipleFiles>>[number];
type ReadMode = NonNullable<ReadMultipleResult['readMode']>;

function buildLineRangeNote(result: ReadMultipleResult): string | undefined {
  if (result.lineStart === undefined || result.lineEnd === undefined) {
    return undefined;
  }
  return `Showing lines ${result.lineStart}-${result.lineEnd}`;
}

function buildHeadNote(result: ReadMultipleResult): string | undefined {
  if (result.head === undefined) return undefined;
  return `Showing first ${String(result.head)} lines`;
}

function buildTailNote(result: ReadMultipleResult): string | undefined {
  if (result.tail === undefined) return undefined;
  return `Showing last ${String(result.tail)} lines`;
}

const RANGE_NOTE_BUILDERS: Record<
  ReadMode,
  (result: ReadMultipleResult) => string | undefined
> = {
  lineRange: buildLineRangeNote,
  head: buildHeadNote,
  tail: buildTailNote,
  full: () => undefined,
};

function buildReadMultipleRangeNote(
  result: ReadMultipleResult
): string | undefined {
  if (!result.readMode) return undefined;
  return RANGE_NOTE_BUILDERS[result.readMode](result);
}

async function handleReadMultipleFiles(
  args: {
    paths: string[];
    encoding?: BufferEncoding;
    maxSize?: number;
    maxTotalSize?: number;
    head?: number;
    tail?: number;
    lineStart?: number;
    lineEnd?: number;
  },
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
  const effectiveOptions = {
    encoding: args.encoding ?? 'utf-8',
    maxSize: Math.min(args.maxSize ?? MAX_TEXT_FILE_SIZE, MAX_TEXT_FILE_SIZE),
    maxTotalSize: args.maxTotalSize ?? 100 * 1024 * 1024,
    head: args.head,
    tail: args.tail,
    lineStart: args.lineStart,
    lineEnd: args.lineEnd,
  };
  const results = await readMultipleFiles(args.paths, {
    encoding: effectiveOptions.encoding,
    maxSize: effectiveOptions.maxSize,
    maxTotalSize: effectiveOptions.maxTotalSize,
    head: effectiveOptions.head,
    tail: effectiveOptions.tail,
    lineStart: effectiveOptions.lineStart,
    lineEnd: effectiveOptions.lineEnd,
    signal,
  });

  return buildToolResponse(
    buildTextResult(results),
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
            READ_MULTIPLE_TIMEOUT_MS
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
