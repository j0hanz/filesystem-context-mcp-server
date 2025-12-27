import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { joinLines } from '../config/formatting.js';
import { ErrorCode, McpError } from '../lib/errors.js';
import { readMultipleFiles } from '../lib/file-operations.js';
import {
  ReadMultipleFilesInputSchema,
  ReadMultipleFilesOutputSchema,
} from '../schemas/index.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
} from './tool-response.js';

type ReadMultipleArgs = z.infer<
  z.ZodObject<typeof ReadMultipleFilesInputSchema>
>;
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
    results,
    summary: {
      total: results.length,
      succeeded,
      failed,
    },
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
    return joinLines([`=== ${result.path} ===`, `${result.content}${note}`]);
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
    return `\n[Truncated. Total lines: ${result.totalLines}]`;
  }
  return '\n[Truncated]';
}

function assertNoMixedRangeOptions(
  hasHeadTail: boolean,
  hasLineRange: boolean,
  pathLabel: string
): void {
  if (!hasHeadTail || !hasLineRange) return;
  throw new McpError(
    ErrorCode.E_INVALID_INPUT,
    'head/tail cannot be combined with lineStart/lineEnd',
    pathLabel
  );
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
  assertNoMixedRangeOptions(
    args.head !== undefined || args.tail !== undefined,
    args.lineStart !== undefined || args.lineEnd !== undefined,
    args.paths[0] ?? '<paths>'
  );
  const results = await readMultipleFiles(args.paths, {
    encoding: args.encoding,
    maxSize: args.maxSize,
    maxTotalSize: args.maxTotalSize,
    head: args.head,
    tail: args.tail,
    lineStart: args.lineStart,
    lineEnd: args.lineEnd,
    signal,
  });

  return buildToolResponse(
    buildTextResult(results),
    buildStructuredResult(results)
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
  outputSchema: ReadMultipleFilesOutputSchema.shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

export function registerReadMultipleFilesTool(server: McpServer): void {
  const handler = async (
    args: ReadMultipleArgs,
    extra: { signal: AbortSignal }
  ): Promise<ToolResult<ReadMultipleStructuredResult>> => {
    try {
      return await handleReadMultipleFiles(args, extra.signal);
    } catch (error: unknown) {
      return buildToolErrorResponse(error, ErrorCode.E_UNKNOWN);
    }
  };

  server.registerTool('read_multiple_files', READ_MULTIPLE_FILES_TOOL, handler);
}
