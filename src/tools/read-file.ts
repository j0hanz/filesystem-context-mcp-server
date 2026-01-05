import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { joinLines } from '../config/formatting.js';
import { MAX_TEXT_FILE_SIZE } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { readFile } from '../lib/file-operations.js';
import { createTimedAbortSignal } from '../lib/fs-helpers.js';
import { assertLineRangeOptions, buildLineRange } from '../lib/line-range.js';
import { withToolDiagnostics } from '../lib/observability/diagnostics.js';
import { ReadFileInputSchema, ReadFileOutputSchema } from '../schemas/index.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
  withToolErrorHandling,
} from './tool-response.js';

const READ_FILE_TIMEOUT_MS = 30000;

function buildTextResult(
  result: Awaited<ReturnType<typeof readFile>>,
  head: number | undefined,
  tail: number | undefined
): string {
  const note = buildReadFileNote(result, head, tail);
  return note ? joinLines([result.content, note]) : result.content;
}

function buildReadFileNote(
  result: Awaited<ReturnType<typeof readFile>>,
  head: number | undefined,
  tail: number | undefined
): string | undefined {
  const rangeNote = buildRangeNote(result);
  const linesNote =
    result.totalLines !== undefined
      ? `Total lines: ${result.totalLines}`
      : undefined;
  if (result.truncated) {
    return joinLines(
      [buildTruncatedNote(result, head, tail), rangeNote, linesNote].filter(
        (value): value is string => Boolean(value)
      )
    );
  }
  return joinLines(
    [rangeNote, linesNote].filter((value): value is string => Boolean(value))
  );
}

function buildTruncatedNote(
  result: Awaited<ReturnType<typeof readFile>>,
  head: number | undefined,
  tail: number | undefined
): string | undefined {
  if (result.totalLines !== undefined) {
    return `Showing requested lines. Total lines in file: ${result.totalLines}`;
  }
  if (head !== undefined) {
    return `Showing first ${String(head)} lines`;
  }
  if (tail !== undefined) {
    return `Showing last ${String(tail)} lines`;
  }
  return undefined;
}

function buildRangeNote(
  result: Awaited<ReturnType<typeof readFile>>
): string | undefined {
  if (result.readMode === 'lineRange') {
    if (result.lineStart !== undefined && result.lineEnd !== undefined) {
      return `Showing lines ${result.lineStart}-${result.lineEnd}`;
    }
  }
  return undefined;
}

type ReadFileArgs = z.infer<typeof ReadFileInputSchema>;
type ReadFileStructuredResult = z.infer<typeof ReadFileOutputSchema>;

interface EffectiveReadOptions {
  encoding: BufferEncoding;
  maxSize: number;
  skipBinary: boolean;
  lineRange?: { start: number; end: number };
  head?: number;
  tail?: number;
}

function buildEffectiveReadOptions(
  args: ReadFileArgs,
  lineRange: { start: number; end: number } | undefined
): EffectiveReadOptions {
  return {
    encoding: args.encoding,
    maxSize: Math.min(args.maxSize, MAX_TEXT_FILE_SIZE),
    skipBinary: args.skipBinary,
    lineRange,
    head: args.head,
    tail: args.tail,
  };
}

function buildStructuredReadResult(
  result: Awaited<ReturnType<typeof readFile>>,
  args: ReadFileArgs,
  effectiveOptions: EffectiveReadOptions
): ReadFileStructuredResult {
  return {
    ok: true,
    path: args.path,
    content: result.content,
    truncated: result.truncated,
    totalLines: result.totalLines,
    readMode: result.readMode,
    lineStart: result.lineStart,
    lineEnd: result.lineEnd,
    head: result.head,
    tail: result.tail,
    linesRead: result.linesRead,
    hasMoreLines: result.hasMoreLines,
    effectiveOptions: {
      encoding: effectiveOptions.encoding,
      maxSize: effectiveOptions.maxSize,
      skipBinary: effectiveOptions.skipBinary,
      lineStart: args.lineStart,
      lineEnd: args.lineEnd,
      head: args.head,
      tail: args.tail,
    },
  };
}

async function handleReadFile(
  args: ReadFileArgs,
  signal?: AbortSignal
): Promise<ToolResponse<ReadFileStructuredResult>> {
  assertLineRangeOptions(
    {
      lineStart: args.lineStart,
      lineEnd: args.lineEnd,
      head: args.head,
      tail: args.tail,
    },
    args.path
  );
  const lineRange = buildLineRange(args.lineStart, args.lineEnd);
  const effectiveOptions = buildEffectiveReadOptions(args, lineRange);
  const result = await readFile(args.path, {
    encoding: effectiveOptions.encoding,
    maxSize: effectiveOptions.maxSize,
    lineRange: effectiveOptions.lineRange,
    head: effectiveOptions.head,
    tail: effectiveOptions.tail,
    skipBinary: effectiveOptions.skipBinary,
    signal,
  });

  const text = buildTextResult(result, args.head, args.tail);
  return buildToolResponse(
    text,
    buildStructuredReadResult(result, args, effectiveOptions)
  );
}

const READ_FILE_TOOL = {
  title: 'Read File',
  description:
    'Read the text contents of a single file. ' +
    'Supports encodings and partial reads via head (first N lines), tail (last N lines), ' +
    'or lineStart/lineEnd (specific line range; mutually exclusive with head/tail). ' +
    'Use skipBinary=true to reject binary files. ' +
    'For multiple files, use read_multiple_files for efficiency.',
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
      'read_file',
      () =>
        withToolErrorHandling(
          async () => {
            const { signal, cleanup } = createTimedAbortSignal(
              extra.signal,
              READ_FILE_TIMEOUT_MS
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

  server.registerTool('read_file', READ_FILE_TOOL, handler);
}
