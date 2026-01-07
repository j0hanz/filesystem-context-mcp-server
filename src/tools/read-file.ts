import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { joinLines } from '../config/formatting.js';
import { MAX_TEXT_FILE_SIZE } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { createTimedAbortSignal } from '../lib/fs-helpers/abort.js';
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

type ReadFileArgs = z.infer<typeof ReadFileInputSchema>;
type ReadFileStructuredResult = z.infer<typeof ReadFileOutputSchema>;
function buildReadFileNote(
  result: Awaited<ReturnType<typeof readFile>>,
  head: number | undefined,
  tail: number | undefined
): string | undefined {
  const notes: string[] = [];
  if (result.truncated) {
    if (result.totalLines !== undefined) {
      notes.push(
        `Showing requested lines. Total lines in file: ${result.totalLines}`
      );
    } else if (head !== undefined) {
      notes.push(`Showing first ${String(head)} lines`);
    } else if (tail !== undefined) {
      notes.push(`Showing last ${String(tail)} lines`);
    }
  }

  if (
    result.readMode === 'lineRange' &&
    result.lineStart !== undefined &&
    result.lineEnd !== undefined
  ) {
    notes.push(`Showing lines ${result.lineStart}-${result.lineEnd}`);
  }

  if (result.totalLines !== undefined) {
    notes.push(`Total lines: ${result.totalLines}`);
  }

  return notes.length ? joinLines(notes) : undefined;
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
  const lineRange =
    args.lineStart !== undefined && args.lineEnd !== undefined
      ? { start: args.lineStart, end: args.lineEnd }
      : undefined;
  const result = await readFile(args.path, {
    encoding: 'utf-8',
    maxSize: MAX_TEXT_FILE_SIZE,
    skipBinary: true,
    lineRange,
    head: args.head,
    tail: args.tail,
    signal,
  });

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
