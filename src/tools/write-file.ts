import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { z } from 'zod';

import { ErrorCode } from '../lib/errors.js';
import { atomicWriteFile, withAbort } from '../lib/fs-helpers.js';
import { validatePathForWrite } from '../lib/paths.js';

import { formatBytes } from '../config.js';
import { WriteFileInputSchema, WriteFileOutputSchema } from '../schemas.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  executeToolWithDiagnostics,
  type ToolContract,
  type ToolExtra,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
  withDefaultIcons,
  withValidatedArgs,
  wrapToolHandler,
} from './shared.js';
import { registerToolTaskIfAvailable } from './task-support.js';

export const WRITE_FILE_TOOL: ToolContract = {
  name: 'write',
  title: 'Write File',
  description:
    'Write content to a file, OVERWRITING ALL existing content. Creates the file and parent directories if needed.',
  inputSchema: WriteFileInputSchema,
  outputSchema: WriteFileOutputSchema,
  annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  taskSupport: 'forbidden',
} as const;

async function handleWriteFile(
  args: z.infer<typeof WriteFileInputSchema>,
  signal?: AbortSignal
): Promise<ToolResponse<z.infer<typeof WriteFileOutputSchema>>> {
  const validPath = await validatePathForWrite(args.path, signal);

  // Ensure parent directory exists
  await withAbort(
    fs.mkdir(path.dirname(validPath), { recursive: true }),
    signal
  );

  await atomicWriteFile(validPath, args.content, { encoding: 'utf-8', signal });

  const bytesWritten = Buffer.byteLength(args.content, 'utf-8');

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
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof WriteFileOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'write',
      extra,
      outputSchema: WriteFileOutputSchema,
      timedSignal: {},
      context: { path: args.path },
      run: (signal) => handleWriteFile(args, signal),
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.E_UNKNOWN, args.path),
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    progressMessage: (args) => `🛠 write: ${path.basename(args.path)}`,
    completionMessage: (args, result) => {
      const name = path.basename(args.path);
      if (result.isError) return `🛠 write: ${name} • failed`;
      const sc = result.structuredContent;
      return `🛠 write: ${name} • ${formatBytes(sc.bytesWritten ?? 0)}`;
    },
  });

  const validatedHandler = withValidatedArgs(
    WriteFileInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      'write',
      WRITE_FILE_TOOL,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  )
    return;
  server.registerTool(
    'write',
    withDefaultIcons({ ...WRITE_FILE_TOOL }, options.iconInfo),
    validatedHandler
  );
}
