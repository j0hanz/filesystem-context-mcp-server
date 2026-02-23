import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode } from '../lib/errors.js';
import { withAbort } from '../lib/fs-helpers.js';
import { validatePathForWrite } from '../lib/path-validation.js';
import {
  CreateDirectoryInputSchema,
  CreateDirectoryOutputSchema,
} from '../schemas.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  executeToolWithDiagnostics,
  IDEMPOTENT_WRITE_TOOL_ANNOTATIONS,
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

export const CREATE_DIRECTORY_TOOL: ToolContract = {
  name: 'mkdir',
  title: 'Create Directory',
  description: 'Create a new directory at the specified path (recursive).',
  inputSchema: CreateDirectoryInputSchema,
  outputSchema: CreateDirectoryOutputSchema,
  annotations: IDEMPOTENT_WRITE_TOOL_ANNOTATIONS,
  nuances: ['Succeeds silently if the directory already exists (idempotent).'],
} as const;

async function handleCreateDirectory(
  args: z.infer<typeof CreateDirectoryInputSchema>,
  signal?: AbortSignal
): Promise<ToolResponse<z.infer<typeof CreateDirectoryOutputSchema>>> {
  const validPath = await validatePathForWrite(args.path, signal);

  await withAbort(fs.mkdir(validPath, { recursive: true }), signal);

  return buildToolResponse(`Successfully created directory: ${args.path}`, {
    ok: true,
    path: validPath,
  });
}

export function registerCreateDirectoryTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof CreateDirectoryInputSchema>,
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof CreateDirectoryOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'mkdir',
      extra,
      timedSignal: {},
      context: { path: args.path },
      run: (signal) => handleCreateDirectory(args, signal),
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.E_UNKNOWN, args.path),
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    progressMessage: (args) => {
      const name = path.basename(args.path) || '.';
      return `🛠 mkdir: ${name}`;
    },
    completionMessage: (args, result) => {
      const name = path.basename(args.path) || '.';
      if (result.isError) return `🛠 mkdir: ${name} • failed`;
      return `🛠 mkdir: ${name} • created`;
    },
  });

  const validatedHandler = withValidatedArgs(
    CreateDirectoryInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      'mkdir',
      CREATE_DIRECTORY_TOOL,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  )
    return;
  server.registerTool(
    'mkdir',
    withDefaultIcons({ ...CREATE_DIRECTORY_TOOL }, options.iconInfo),
    validatedHandler
  );
}
