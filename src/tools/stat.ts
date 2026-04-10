import type { McpServer } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import type { z } from 'zod';

import { DEFAULT_SEARCH_TIMEOUT_MS } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { getFileInfo } from '../lib/file-operations/metadata.js';

import { type FileInfo, formatBytes, joinLines } from '../config.js';
import { GetFileInfoInputSchema, GetFileInfoOutputSchema } from '../schemas.js';
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
  withDefaultIcons,
  withValidatedArgs,
  wrapToolHandler,
} from './shared.js';
import { registerToolTaskIfAvailable } from './task-support.js';

export const GET_FILE_INFO_TOOL: ToolContract = {
  name: 'stat',
  title: 'Get File Info',
  description:
    'Get file/directory metadata: size, modified, permissions, mime, tokenEstimate. ' +
    'Use `tokenEstimate` (size\u00f74) to pre-screen token cost before reading.',
  inputSchema: GetFileInfoInputSchema,
  outputSchema: GetFileInfoOutputSchema,
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
  args: z.infer<typeof GetFileInfoInputSchema>,
  signal?: AbortSignal
): Promise<ToolResponse<z.infer<typeof GetFileInfoOutputSchema>>> {
  const info = await getFileInfo(args.path, {
    includeMimeType: true,
    ...(signal ? { signal } : {}),
  });

  const structured: z.infer<typeof GetFileInfoOutputSchema> = {
    ok: true,
    info: buildFileInfoPayload(info),
  };

  return buildToolResponse(formatFileInfoDetails(info), structured);
}

export function registerGetFileInfoTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof GetFileInfoInputSchema>,
    ctx: ToolContext
  ): Promise<ToolResult<z.infer<typeof GetFileInfoOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'stat',
      ctx,
      outputSchema: GetFileInfoOutputSchema,
      timedSignal: { timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS },
      context: { path: args.path },
      run: (signal) => handleGetFileInfo(args, signal),
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.NOT_FOUND, args.path),
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    progressMessage: (args) => `🕮 stat: ${basename(args.path)}`,
    completionMessage: (args, result) => {
      const name = basename(args.path);
      if (result.isError) return `🕮 stat: ${name} • failed`;
      const sc = result.structuredContent;
      if (!sc.info) return `🕮 stat: ${name} • failed`;
      return `🕮 stat: ${sc.info.name} • ${sc.info.type}, ${formatBytes(sc.info.size)}`;
    },
  });

  const validatedHandler = withValidatedArgs(
    GetFileInfoInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      'stat',
      GET_FILE_INFO_TOOL,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  )
    return;
  server.registerTool(
    'stat',
    withDefaultIcons({ ...GET_FILE_INFO_TOOL }, options.iconInfo),
    validatedHandler
  );
}
