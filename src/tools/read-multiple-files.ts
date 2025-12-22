import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode, toRpcError } from '../lib/errors.js';
import { readMultipleFiles } from '../lib/file-operations.js';
import {
  ReadMultipleFilesInputSchema,
  ReadMultipleFilesOutputSchema,
} from '../schemas/index.js';
import { buildToolResponse, type ToolResponse } from './tool-response.js';

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
  return results.map(formatReadMultipleResult).join('\n\n');
}

function formatReadMultipleResult(
  result: Awaited<ReturnType<typeof readMultipleFiles>>[number]
): string {
  if (result.content !== undefined) {
    const note = buildReadMultipleNote(result);
    return `=== ${result.path} ===\n${result.content}${note}`;
  }
  return `=== ${result.path} ===\n[Error: ${result.error ?? 'Unknown error'}]`;
}

function buildReadMultipleNote(
  result: Awaited<ReturnType<typeof readMultipleFiles>>[number]
): string {
  if (result.truncated !== true) return '';
  if (result.totalLines !== undefined) {
    return `\n\n[Truncated. Total lines: ${result.totalLines}]`;
  }
  return '\n\n[Truncated]';
}

async function handleReadMultipleFiles(args: {
  paths: string[];
  encoding?: BufferEncoding;
  maxSize?: number;
  maxTotalSize?: number;
  head?: number;
  tail?: number;
}): Promise<ToolResponse<ReadMultipleStructuredResult>> {
  const results = await readMultipleFiles(args.paths, {
    encoding: args.encoding,
    maxSize: args.maxSize,
    maxTotalSize: args.maxTotalSize,
    head: args.head,
    tail: args.tail,
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
    'Individual file errors do not fail the entire operation-each file reports success or error independently. ' +
    'Supports head/tail for reading partial content from all files.',
  inputSchema: ReadMultipleFilesInputSchema,
  outputSchema: ReadMultipleFilesOutputSchema.shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

export function registerReadMultipleFilesTool(server: McpServer): void {
  server.registerTool(
    'read_multiple_files',
    READ_MULTIPLE_FILES_TOOL,
    async (args: ReadMultipleArgs) => {
      try {
        return await handleReadMultipleFiles(args);
      } catch (error: unknown) {
        throw toRpcError(error, ErrorCode.E_UNKNOWN);
      }
    }
  );
}
