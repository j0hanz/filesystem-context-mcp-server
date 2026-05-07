import type { McpServer } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import type { z } from 'zod/v4';

import { DEFAULT_SEARCH_TIMEOUT_MS } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { getFileInfo } from '../lib/file-operations/metadata.js';
import { StatInputSchema } from '../schemas/inputs.js';
import { StatOutputSchema } from '../schemas/outputs.js';

import { type FileInfo, formatBytes, joinLines } from '../config.js';
import { FILE_READ_ICONS } from './icons.js';
import {
  buildFileInfoPayload,
  buildToolErrorResponse,
  buildToolResponse,
  executeToolWithDiagnostics,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
} from './shared.js';
import { registerStandardTool } from './task-support.js';

export const GET_FILE_INFO_TOOL: ToolContract = {
  name: 'stat',
  title: 'Get File Info',
  description:
    'Get file/directory metadata: size, modified, permissions, mime, tokenEstimate. ' +
    'Use `tokenEstimate` (size\u00f74) to pre-screen token cost before reading.',
  inputSchema: StatInputSchema,
  outputSchema: StatOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: FILE_READ_ICONS,
  taskSupport: 'forbidden',
} as const;

function formatFileInfoDetails(info: FileInfo): string {
  const lines = [
    `${info.name} (${info.type})`,
    `  Path: ${info.path}`,
    `  Size: ${formatBytes(info.size)}`,
    `  Modified: ${info.modified.toISOString()}`,
  ];

  if (info.mimeType) lines.push(`  Type: ${info.mimeType}`);
  if (info.symlinkTarget) lines.push(`  Target: ${info.symlinkTarget}`);

  return joinLines(lines);
}

async function handleGetFileInfo(
  args: z.infer<typeof StatInputSchema>,
  signal?: AbortSignal
): Promise<ToolResponse<z.infer<typeof StatOutputSchema>>> {
  const info = await getFileInfo(args.path ?? '', {
    includeMimeType: true,
    ...(signal ? { signal } : {}),
  });

  const structured: z.infer<typeof StatOutputSchema> = {
    ok: true,
    file: buildFileInfoPayload(info),
  };

  return buildToolResponse(formatFileInfoDetails(info), structured);
}

export function registerGetFileInfoTool(
  server: McpServer,
  options: ToolRegistrationOptions
): void {
  const handler = (
    args: z.infer<typeof StatInputSchema>,
    ctx: ToolContext
  ): Promise<ToolResult<z.infer<typeof StatOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'stat',
      ctx,
      outputSchema: StatOutputSchema,
      timedSignal: { timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS },
      context: { path: args.path },
      run: (signal) => handleGetFileInfo(args, signal),
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.NOT_FOUND, args.path),
    });

  registerStandardTool(server, GET_FILE_INFO_TOOL, handler, options, {
    progressMessage: (args) =>
      `${GET_FILE_INFO_TOOL.title}: ${basename(args.path ?? '')}`,
    completionMessage: (args, result) => {
      const name = basename(args.path ?? '');
      if (result.isError)
        return `${GET_FILE_INFO_TOOL.title}: ${name} • ${result.errorCode}`;
      const sc = result.structuredContent;
      return `${GET_FILE_INFO_TOOL.title}: ${sc.file.name} • ${formatBytes(sc.file.size)}`;
    },
  });
}
