import type { McpServer } from '@modelcontextprotocol/server';

import { mkdir } from 'node:fs/promises';
import { basename } from 'node:path';

import type { z } from 'zod';

import { withAbort } from '../lib/abort.js';
import { ErrorCode, McpError } from '../lib/errors.js';
import { validatePathForWrite } from '../lib/paths.js';

import {
  CreateDirectoryInputSchema,
  CreateDirectoryOutputSchema,
} from '../schemas.js';
import { DIR_CREATE_ICONS } from './icons.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  executeToolWithDiagnostics,
  IDEMPOTENT_WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
} from './shared.js';
import { registerStandardTool } from './task-support.js';

export const CREATE_DIRECTORY_TOOL: ToolContract = {
  name: 'mkdir',
  title: 'Create Directory',
  description: 'Create a new directory at the specified path (recursive).',
  inputSchema: CreateDirectoryInputSchema,
  outputSchema: CreateDirectoryOutputSchema,
  annotations: IDEMPOTENT_WRITE_TOOL_ANNOTATIONS,
  icons: DIR_CREATE_ICONS,
  taskSupport: 'forbidden',
} as const;

async function handleCreateDirectory(
  args: z.infer<typeof CreateDirectoryInputSchema>,
  signal?: AbortSignal
): Promise<ToolResponse<z.infer<typeof CreateDirectoryOutputSchema>>> {
  const allPaths: string[] = [];
  if (args.path) allPaths.push(args.path);
  if (args.paths) allPaths.push(...args.paths);

  if (allPaths.length === 0) {
    throw new McpError(ErrorCode.INVALID_INPUT, 'No paths provided to create.');
  }

  const validPaths = await Promise.all(
    allPaths.map((p) => validatePathForWrite(p, signal))
  );

  await Promise.all(
    validPaths.map((p) => withAbort(mkdir(p, { recursive: true }), signal))
  );

  const createdPath = validPaths.length === 1 ? validPaths[0] : undefined;

  return buildToolResponse(
    `Successfully created ${validPaths.length} director${validPaths.length === 1 ? 'y' : 'ies'}`,
    {
      ok: true,
      ...(createdPath ? { path: createdPath } : {}),
      paths: validPaths,
    }
  );
}

export function registerCreateDirectoryTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof CreateDirectoryInputSchema>,
    ctx: ToolContext
  ): Promise<ToolResult<z.infer<typeof CreateDirectoryOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'mkdir',
      ctx,
      outputSchema: CreateDirectoryOutputSchema,
      timedSignal: {},
      context: { path: args.path ?? args.paths?.[0] },
      run: (signal) => handleCreateDirectory(args, signal),
      onError: (error) =>
        buildToolErrorResponse(
          error,
          ErrorCode.UNKNOWN,
          args.path ?? args.paths?.[0]
        ),
    });

  registerStandardTool(server, CREATE_DIRECTORY_TOOL, handler, options, {
    progressMessage: (args) => {
      if (args.path && !args.paths?.length) {
        return `🛠 mkdir: ${basename(args.path)}`;
      }
      const count = (args.path ? 1 : 0) + (args.paths?.length ?? 0);
      return `🛠 mkdir: ${count} directories`;
    },
    completionMessage: (args, result) => {
      if (args.path && !args.paths?.length) {
        const name = basename(args.path);
        if (result.isError) return `🛠 mkdir: ${name} • failed`;
        return `🛠 mkdir: ${name}`;
      }
      const count = (args.path ? 1 : 0) + (args.paths?.length ?? 0);
      if (result.isError) return `🛠 mkdir: ${count} directories • failed`;
      return `🛠 mkdir: ${count} directories`;
    },
  });
}
