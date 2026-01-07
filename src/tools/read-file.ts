import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { joinLines } from '../config/formatting.js';
import { MAX_TEXT_FILE_SIZE } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { createTimedAbortSignal } from '../lib/fs-helpers.js';
import { readFile } from '../lib/fs-helpers/readers/read-file.js';
import { assertLineRangeOptions } from '../lib/line-range.js';
import { withToolDiagnostics } from '../lib/observability/diagnostics.js';
import { ReadFileInputSchema, ReadFileOutputSchema } from '../schemas/index.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
  withToolErrorHandling,
} from './tool-response.js';

function buildReadFileNote(
  result: Awaited<ReturnType<typeof readFile>>,
  head: number | undefined,
  tail: number | undefined
): string | undefined {
  const rangeNote = buildRangeNote(result);
  const linesNote = buildLinesNote(result);
  if (result.truncated) {
    return joinNotes(
      buildTruncatedNote(result, head, tail),
      rangeNote,
      linesNote
    );
  }
  return joinNotes(rangeNote, linesNote);
}

type ReadFileArgs = z.infer<typeof ReadFileInputSchema>;
type ReadFileStructuredResult = z.infer<typeof ReadFileOutputSchema>;

// Hardcoded defaults for removed parameters
const DEFAULT_ENCODING: BufferEncoding = 'utf-8';
const DEFAULT_SKIP_BINARY = true;

interface EffectiveReadOptions {
  encoding: BufferEncoding;
  maxSize: number;
  skipBinary: boolean;
  lineRange?: { start: number; end: number };
  head?: number;
  tail?: number;
}

function buildRangeNote(
  result: Awaited<ReturnType<typeof readFile>>
): string | undefined {
  if (
    result.readMode === 'lineRange' &&
    result.lineStart !== undefined &&
    result.lineEnd !== undefined
  ) {
    return `Showing lines ${result.lineStart}-${result.lineEnd}`;
  }
  return undefined;
}

function buildLinesNote(
  result: Awaited<ReturnType<typeof readFile>>
): string | undefined {
  return result.totalLines !== undefined
    ? `Total lines: ${result.totalLines}`
    : undefined;
}

function buildTruncatedNote(
  result: Awaited<ReturnType<typeof readFile>>,
  head: number | undefined,
  tail: number | undefined
): string | undefined {
  if (result.totalLines !== undefined) {
    return `Showing requested lines. Total lines in file: ${result.totalLines}`;
  }
  if (head !== undefined) return `Showing first ${String(head)} lines`;
  if (tail !== undefined) return `Showing last ${String(tail)} lines`;
  return undefined;
}

function joinNotes(...notes: (string | undefined)[]): string | undefined {
  return joinLines(notes.filter((value): value is string => Boolean(value)));
}

function buildEffectiveReadOptions(
  args: ReadFileArgs,
  lineRange: { start: number; end: number } | undefined
): EffectiveReadOptions {
  return {
    encoding: DEFAULT_ENCODING,
    maxSize: MAX_TEXT_FILE_SIZE,
    skipBinary: DEFAULT_SKIP_BINARY,
    lineRange,
    head: args.head,
    tail: args.tail,
  };
}

function resolveLineRange(
  args: ReadFileArgs
): { start: number; end: number } | undefined {
  return args.lineStart !== undefined && args.lineEnd !== undefined
    ? { start: args.lineStart, end: args.lineEnd }
    : undefined;
}

function buildReadOptions(
  effectiveOptions: EffectiveReadOptions,
  signal?: AbortSignal
): Parameters<typeof readFile>[1] {
  return {
    encoding: effectiveOptions.encoding,
    maxSize: effectiveOptions.maxSize,
    lineRange: effectiveOptions.lineRange,
    head: effectiveOptions.head,
    tail: effectiveOptions.tail,
    skipBinary: effectiveOptions.skipBinary,
    signal,
  };
}

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
    readMode: result.readMode,
    lineStart: result.lineStart,
    lineEnd: result.lineEnd,
    head: result.head,
    tail: result.tail,
    linesRead: result.linesRead,
    hasMoreLines: result.hasMoreLines,
    effectiveOptions: {
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
  const lineRange = resolveLineRange(args);
  const effectiveOptions = buildEffectiveReadOptions(args, lineRange);
  const result = await readFile(
    args.path,
    buildReadOptions(effectiveOptions, signal)
  );

  const note = buildReadFileNote(result, args.head, args.tail);
  const text = note ? joinLines([result.content, note]) : result.content;
  return buildToolResponse(text, buildStructuredReadResult(result, args));
}

const READ_FILE_TOOL = {
  title: 'Read File',
  description:
    'Read the text contents of a single file. ' +
    'Supports partial reads via head (first N lines), tail (last N lines), ' +
    'or lineStart/lineEnd (specific line range; mutually exclusive with head/tail). ' +
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
              30000
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
