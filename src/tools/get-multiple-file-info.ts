import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import type { GetMultipleFileInfoResult } from '../config/types.js';
import { ErrorCode } from '../lib/errors.js';
import { getMultipleFileInfo } from '../lib/file-operations.js';
import {
  GetMultipleFileInfoInputSchema,
  GetMultipleFileInfoOutputSchema,
} from '../schemas/index.js';
import { formatBytes } from './shared/formatting.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
} from './tool-response.js';

type GetMultipleFileInfoArgs = z.infer<
  z.ZodObject<typeof GetMultipleFileInfoInputSchema>
>;
type GetMultipleFileInfoStructuredResult = z.infer<
  typeof GetMultipleFileInfoOutputSchema
>;

function buildStructuredResult(
  result: GetMultipleFileInfoResult
): GetMultipleFileInfoStructuredResult {
  return {
    ok: true,
    results: result.results.map((r) => ({
      path: r.path,
      info: r.info
        ? {
            name: r.info.name,
            path: r.info.path,
            type: r.info.type,
            size: r.info.size,
            created: r.info.created.toISOString(),
            modified: r.info.modified.toISOString(),
            accessed: r.info.accessed.toISOString(),
            permissions: r.info.permissions,
            isHidden: r.info.isHidden,
            mimeType: r.info.mimeType,
            symlinkTarget: r.info.symlinkTarget,
          }
        : undefined,
      error: r.error,
    })),
    summary: result.summary,
  };
}

function buildTextResult(result: GetMultipleFileInfoResult): string {
  const lines: string[] = [];

  lines.push(`File Information (${result.summary.total} files):`);
  lines.push('');

  for (const item of result.results) {
    lines.push(...formatFileInfoBlock(item));
  }

  lines.push('Summary:');
  lines.push(`  Total: ${result.summary.total}`);
  lines.push(`  Succeeded: ${result.summary.succeeded}`);
  lines.push(`  Failed: ${result.summary.failed}`);
  lines.push(`  Total Size: ${formatBytes(result.summary.totalSize)}`);

  return lines.join('\n');
}

function formatFileInfoBlock(
  item: GetMultipleFileInfoResult['results'][number]
): string[] {
  if (!item.info) {
    return [
      `=== ${item.path} ===`,
      `  [Error: ${item.error ?? 'Unknown error'}]`,
      '',
    ];
  }

  const lines = [
    `=== ${item.path} ===`,
    `  Type: ${item.info.type}`,
    `  Size: ${formatBytes(item.info.size)}`,
    `  Modified: ${item.info.modified.toISOString()}`,
  ];
  if (item.info.mimeType) {
    lines.push(`  MIME: ${item.info.mimeType}`);
  }
  lines.push('');
  return lines;
}

async function handleGetMultipleFileInfo(
  args: GetMultipleFileInfoArgs
): Promise<ToolResponse<GetMultipleFileInfoStructuredResult>> {
  const result = await getMultipleFileInfo(args.paths, {
    includeMimeType: args.includeMimeType,
  });

  return buildToolResponse(
    buildTextResult(result),
    buildStructuredResult(result)
  );
}

const GET_MULTIPLE_FILE_INFO_TOOL = {
  title: 'Get Multiple File Info',
  description:
    'Retrieve detailed metadata about multiple files or directories in a single operation (parallel processing). ' +
    'More efficient than calling get_file_info repeatedly. ' +
    'Individual file errors do not fail the entire operation—each file reports success or error independently. ' +
    'Returns: name, path, type, size, timestamps, permissions, MIME type, and symlink target for each path.',
  inputSchema: GetMultipleFileInfoInputSchema,
  outputSchema: GetMultipleFileInfoOutputSchema.shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

const GET_MULTIPLE_FILE_INFO_TOOL_DEPRECATED = {
  ...GET_MULTIPLE_FILE_INFO_TOOL,
  description: `${GET_MULTIPLE_FILE_INFO_TOOL.description} (Deprecated: use getMultipleFileInfo.)`,
} as const;

export function registerGetMultipleFileInfoTool(server: McpServer): void {
  const handler = async (
    args: GetMultipleFileInfoArgs
  ): Promise<ToolResult<GetMultipleFileInfoStructuredResult>> => {
    try {
      return await handleGetMultipleFileInfo(args);
    } catch (error: unknown) {
      return buildToolErrorResponse(error, ErrorCode.E_UNKNOWN);
    }
  };

  server.registerTool(
    'get_multiple_file_info',
    GET_MULTIPLE_FILE_INFO_TOOL_DEPRECATED,
    handler
  );
  server.registerTool(
    'getMultipleFileInfo',
    GET_MULTIPLE_FILE_INFO_TOOL,
    handler
  );
}
