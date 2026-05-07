import type { McpServer } from '@modelcontextprotocol/server';

import { mkdir } from 'node:fs/promises';
import { basename } from 'node:path';

import type { z } from 'zod/v4';

import { withAbort } from '../lib/abort.js';
import { ErrorCode } from '../lib/errors.js';
import { validatePathForWrite } from '../lib/paths.js';
import { CreateDirectoryInputSchema } from '../schemas/inputs.js';
import { CreateDirectoryOutputSchema } from '../schemas/outputs.js';

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
  const validPaths = await Promise.all(
    args.paths.map((p) => validatePathForWrite(p, signal))
  );

  const results = await Promise.all(
    validPaths.map(async (p) => {
      const isNew = await withAbort(mkdir(p, { recursive: true }), signal)
        .then((created) => created !== undefined)
        .catch(() => false);
      return { path: p, isNew };
    })
  );

  const succeeded = results.length;
  const label = succeeded === 1 ? 'directory' : 'directories';

  return buildToolResponse(`Created ${succeeded} ${label}`, {
    ok: true,
    created: results,
    summary: { total: results.length, succeeded, failed: 0 },
  });
}

export function registerCreateDirectoryTool(
  server: McpServer,
  options: ToolRegistrationOptions
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
      context: { path: args.paths[0] ?? '' },
      run: (signal) => handleCreateDirectory(args, signal),
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.UNKNOWN, args.paths[0] ?? ''),
    });

  registerStandardTool(server, CREATE_DIRECTORY_TOOL, handler, options, {
    progressMessage: (args) => {
      if (args.paths.length === 1) {
        return `${CREATE_DIRECTORY_TOOL.title}: ${basename(args.paths[0] ?? '')}`;
      }
      return `${CREATE_DIRECTORY_TOOL.title}: ${args.paths.length} directories`;
    },
    completionMessage: (args, result) => {
      if (args.paths.length === 1) {
        const name = basename(args.paths[0] ?? '');
        if (result.isError)
          return `${CREATE_DIRECTORY_TOOL.title}: ${name} • ${result.errorCode}`;
        return `${CREATE_DIRECTORY_TOOL.title}: ${name}`;
      }
      if (result.isError)
        return `${CREATE_DIRECTORY_TOOL.title}: ${args.paths.length} directories • ${result.errorCode}`;
      return `${CREATE_DIRECTORY_TOOL.title}: ${args.paths.length} directories`;
    },
  });
}
