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
  if (hasLineStart !== hasLineEnd) {
    const missing = hasLineStart ? 'lineEnd' : 'lineStart';
    const provided = hasLineStart ? 'lineStart' : 'lineEnd';
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      `Invalid lineRange: ${provided} requires ${missing} to also be specified`,
      filePath
    );
  }

  if (lineStart !== undefined && lineEnd !== undefined) {
    return { start: lineStart, end: lineEnd };
  }

  return undefined;
}

function buildTextResult(
  result: Awaited<ReturnType<typeof readFile>>,
  head: number | undefined,
  tail: number | undefined
): string {
  let text = result.content;
  if (result.truncated) {
    if (result.totalLines) {
      text += `\n\n[Showing requested lines. Total lines in file: ${result.totalLines}]`;
    } else if (head !== undefined) {
      text += `\n\n[Showing first ${String(head)} lines]`;
    } else if (tail !== undefined) {
      text += `\n\n[Showing last ${String(tail)} lines]`;
    }
  } else if (result.totalLines) {
    text += `\n\n[Total lines: ${result.totalLines}]`;
  }
  return text;
}

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
  outputSchema: ReadFileOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

export function registerReadFileTool(server: McpServer): void {
  server.registerTool('read_file', READ_FILE_TOOL, async (args) => {
    try {
      return await handleReadFile(args);
    } catch (error) {
      throw toRpcError(error, ErrorCode.E_NOT_FILE, args.path);
    }
  });
}
