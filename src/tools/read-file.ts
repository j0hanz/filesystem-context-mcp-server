import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { joinLines } from '../config/formatting.js';
import { ErrorCode } from '../lib/errors.js';
import { readFile } from '../lib/file-operations.js';
import { ReadFileInputSchema, ReadFileOutputSchema } from '../schemas/index.js';
import {
  assertNoMixedRangeOptions,
  buildLineRange,
} from './shared/read-range.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
  withToolErrorHandling,
} from './tool-response.js';

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
  if (result.truncated) {
    return buildTruncatedNote(result, head, tail);
  }
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
  if (head !== undefined) {
    return `Showing first ${String(head)} lines`;
  }
  if (tail !== undefined) {
    return `Showing last ${String(tail)} lines`;
  }
  return undefined;
}

type ReadFileArgs = z.infer<z.ZodObject<typeof ReadFileInputSchema>>;
type ReadFileStructuredResult = z.infer<typeof ReadFileOutputSchema>;

async function handleReadFile(args: {
  path: string;
  encoding?: BufferEncoding;
  maxSize?: number;
  lineStart?: number;
  lineEnd?: number;
  head?: number;
  tail?: number;
  skipBinary?: boolean;
}): Promise<ToolResponse<ReadFileStructuredResult>> {
  const hasHeadTail = args.head !== undefined || args.tail !== undefined;
  const hasLineRange =
    args.lineStart !== undefined || args.lineEnd !== undefined;
  assertNoMixedRangeOptions(hasHeadTail, hasLineRange, args.path);
  const lineRange = buildLineRange(args.lineStart, args.lineEnd, args.path);
  const result = await readFile(args.path, {
    encoding: args.encoding,
    maxSize: args.maxSize,
    lineRange,
    head: args.head,
    tail: args.tail,
    skipBinary: args.skipBinary,
  });

  const structured: ReadFileStructuredResult = {
    ok: true,
    path: args.path,
    content: result.content,
    truncated: result.truncated,
    totalLines: result.totalLines,
  };

  const text = buildTextResult(result, args.head, args.tail);
  return buildToolResponse(text, structured);
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
  outputSchema: ReadFileOutputSchema.shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

export function registerReadFileTool(server: McpServer): void {
  const handler = (
    args: ReadFileArgs
  ): Promise<ToolResult<ReadFileStructuredResult>> =>
    withToolErrorHandling(
      () => handleReadFile(args),
      (error) => buildToolErrorResponse(error, ErrorCode.E_NOT_FILE, args.path)
    );

  server.registerTool('read_file', READ_FILE_TOOL, handler);
}
