import type { McpServer } from '@modelcontextprotocol/server';

import { mkdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type { z } from 'zod/v4';

import { withAbort } from '../lib/abort.js';
import { ErrorCode } from '../lib/errors.js';
import { atomicWriteFile } from '../lib/fs-helpers.js';
import { Logger } from '../lib/logger.js';
import { validatePathForWrite } from '../lib/paths.js';

import { formatBytes } from '../config.js';
import { WriteFileInputSchema, WriteFileOutputSchema } from '../schemas.js';
import { FILE_EDIT_ICONS } from './icons.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  executeToolWithDiagnostics,
  type ToolContext,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
} from './shared.js';
import { registerStandardTool } from './task-support.js';

export const WRITE_FILE_TOOL: ToolContract = {
  name: 'write',
  title: 'Write File',
  description:
    'Write content to a file, OVERWRITING ALL existing content. Creates the file and parent directories if needed.',
  inputSchema: WriteFileInputSchema,
  outputSchema: WriteFileOutputSchema,
  annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  icons: FILE_EDIT_ICONS,
  taskSupport: 'forbidden',
} as const;

async function handleWriteFile(
  args: z.infer<typeof WriteFileInputSchema>,
  signal?: AbortSignal
): Promise<ToolResponse<z.infer<typeof WriteFileOutputSchema>>> {
  const validPath = await validatePathForWrite(args.path, signal);

  // Ensure parent directory exists
  await withAbort(mkdir(dirname(validPath), { recursive: true }), signal);

  await atomicWriteFile(validPath, args.content, { encoding: 'utf-8', signal });

  const bytesWritten = Buffer.byteLength(args.content, 'utf-8');

  Logger.info(`write: ${args.path} (${bytesWritten} bytes)`);

  return buildToolResponse(`Successfully wrote to file: ${args.path}`, {
    ok: true,
    path: validPath,
    bytesWritten,
  });
}

export function registerWriteFileTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof WriteFileInputSchema>,
    ctx: ToolContext
  ): Promise<ToolResult<z.infer<typeof WriteFileOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'write',
      ctx,
      outputSchema: WriteFileOutputSchema,
      timedSignal: {},
      context: { path: args.path },
      run: async (signal) => {
        const result = await handleWriteFile(args, signal);
        void ctx.log?.(
          'info',
          `write: ${args.path} (${String(result.structuredContent.bytesWritten ?? 0)} bytes)`,
          'write'
        );
        return result;
      },
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.UNKNOWN, args.path),
    });

  registerStandardTool(server, WRITE_FILE_TOOL, handler, options, {
    progressMessage: (args) =>
      `${WRITE_FILE_TOOL.title}: ${basename(args.path)}`,
    completionMessage: (args, result) => {
      const name = basename(args.path);
      if (result.isError)
        return `${WRITE_FILE_TOOL.title}: ${name} • ${result.errorCode}`;
      const sc = result.structuredContent;
      return `${WRITE_FILE_TOOL.title}: ${name} • ${formatBytes(sc.bytesWritten ?? 0)}`;
    },
  });
}
