import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode, McpError, toRpcError } from '../lib/errors.js';
import { readFile } from '../lib/file-operations.js';
import { ReadFileInputSchema, ReadFileOutputSchema } from '../schemas/index.js';
import { buildToolResponse, type ToolResponse } from './tool-response.js';

function buildLineRange(
  lineStart: number | undefined,
  lineEnd: number | undefined,
  filePath: string
): { start: number; end: number } | undefined {
  const hasLineStart = lineStart !== undefined;
  const hasLineEnd = lineEnd !== undefined;
  assertLineRangeComplete(hasLineStart, hasLineEnd, filePath);
  if (hasLineStart && hasLineEnd) return { start: lineStart, end: lineEnd };

  return undefined;
}

function assertLineRangeComplete(
  hasLineStart: boolean,
  hasLineEnd: boolean,
  filePath: string
): void {
  if (hasLineStart === hasLineEnd) return;
  const missing = hasLineStart ? 'lineEnd' : 'lineStart';
  const provided = hasLineStart ? 'lineStart' : 'lineEnd';
  throw new McpError(
    ErrorCode.E_INVALID_INPUT,
    `Invalid lineRange: ${provided} requires ${missing} to also be specified`,
    filePath
  );
}

function buildTextResult(
  result: Awaited<ReturnType<typeof readFile>>,
  head: number | undefined,
  tail: number | undefined
): string {
  const note = buildReadFileNote(result, head, tail);
  return note ? `${result.content}\n${note}` : result.content;
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
}): Promise<ToolResponse<ReadFileStructuredResult>> {
  const lineRange = buildLineRange(args.lineStart, args.lineEnd, args.path);
  const result = await readFile(args.path, {
    encoding: args.encoding,
    maxSize: args.maxSize,
    lineRange,
    head: args.head,
    tail: args.tail,
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
    'Supports different encodings and partial reads via head (first N lines), tail (last N lines), ' +
    'or lineStart/lineEnd (specific line range). ' +
    'For multiple files, use read_multiple_files for efficiency. ' +
    'For binary/media files, use read_media_file instead.',
  inputSchema: ReadFileInputSchema,
  outputSchema: ReadFileOutputSchema.shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

export function registerReadFileTool(server: McpServer): void {
  server.registerTool(
    'read_file',
    READ_FILE_TOOL,
    async (args: ReadFileArgs) => {
      try {
        return await handleReadFile(args);
      } catch (error: unknown) {
        throw toRpcError(error, ErrorCode.E_NOT_FILE, args.path);
      }
    }
  );
}
