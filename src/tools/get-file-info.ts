import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode } from '../lib/errors.js';
import { getFileInfo } from '../lib/file-operations.js';
import {
  GetFileInfoInputSchema,
  GetFileInfoOutputSchema,
} from '../schemas/index.js';
import { formatBytes, formatDate } from './shared/formatting.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
} from './tool-response.js';

type GetFileInfoArgs = z.infer<z.ZodObject<typeof GetFileInfoInputSchema>>;
type GetFileInfoStructuredResult = z.infer<typeof GetFileInfoOutputSchema>;

function formatFileInfo(info: Awaited<ReturnType<typeof getFileInfo>>): string {
  const lines = [
    `Name: ${info.name}`,
    `Path: ${info.path}`,
    `Type: ${info.type}`,
    `Size: ${formatBytes(info.size)}`,
    `Created: ${formatDate(info.created)}`,
    `Modified: ${formatDate(info.modified)}`,
    `Accessed: ${formatDate(info.accessed)}`,
    `Permissions: ${info.permissions}`,
    `Hidden: ${info.isHidden ? 'Yes' : 'No'}`,
  ];

  if (info.mimeType) lines.push(`MIME Type: ${info.mimeType}`);
  if (info.symlinkTarget) lines.push(`Symlink Target: ${info.symlinkTarget}`);

  return lines.join('\n');
}

function buildStructuredResult(
  info: Awaited<ReturnType<typeof getFileInfo>>
): GetFileInfoStructuredResult {
  return {
    ok: true,
    info: {
      name: info.name,
      path: info.path,
      type: info.type,
      size: info.size,
      created: info.created.toISOString(),
      modified: info.modified.toISOString(),
      accessed: info.accessed.toISOString(),
      permissions: info.permissions,
      isHidden: info.isHidden,
      mimeType: info.mimeType,
      symlinkTarget: info.symlinkTarget,
    },
  };
}

async function handleGetFileInfo({
  path,
}: {
  path: string;
}): Promise<ToolResponse<GetFileInfoStructuredResult>> {
  const info = await getFileInfo(path);
  const structured = buildStructuredResult(info);
  return buildToolResponse(formatFileInfo(info), structured);
}

const GET_FILE_INFO_TOOL = {
  title: 'Get File Info',
  description:
    'Retrieve detailed metadata about a file or directory without reading its contents. ' +
    'Returns: name, path, type, size, timestamps (created/modified/accessed), permissions, ' +
    'MIME type (for files), hidden status, and symlink target (if applicable). ' +
    'Use this to check file properties before reading large files.',
  inputSchema: GetFileInfoInputSchema,
  outputSchema: GetFileInfoOutputSchema.shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

const GET_FILE_INFO_TOOL_DEPRECATED = {
  ...GET_FILE_INFO_TOOL,
  description: `${GET_FILE_INFO_TOOL.description} (Deprecated: use getFileInfo.)`,
} as const;

export function registerGetFileInfoTool(server: McpServer): void {
  const handler = async (
    args: GetFileInfoArgs
  ): Promise<ToolResult<GetFileInfoStructuredResult>> => {
    try {
      return await handleGetFileInfo(args);
    } catch (error: unknown) {
      return buildToolErrorResponse(error, ErrorCode.E_NOT_FOUND, args.path);
    }
  };

  server.registerTool('get_file_info', GET_FILE_INFO_TOOL_DEPRECATED, handler);
  server.registerTool('getFileInfo', GET_FILE_INFO_TOOL, handler);
}
