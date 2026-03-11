import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { ErrorCode, McpError } from '../lib/errors.js';
import { withAbort } from '../lib/fs-helpers.js';
import { validatePathForWrite } from '../lib/paths.js';

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
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'No paths provided to create.'
    );
  }

  const validPaths = await Promise.all(
    allPaths.map((p) => validatePathForWrite(p, signal))
  );

  await Promise.all(
    validPaths.map((p) => withAbort(fs.mkdir(p, { recursive: true }), signal))
  );

  return buildToolResponse(
    `Successfully created ${validPaths.length} director${validPaths.length === 1 ? 'y' : 'ies'}`,
    {
      ok: true,
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
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof CreateDirectoryOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'mkdir',
      extra,
      outputSchema: CreateDirectoryOutputSchema,
      timedSignal: {},
      context: { path: args.path ?? args.paths?.[0] },
      run: (signal) => handleCreateDirectory(args, signal),
      onError: (error) =>
        buildToolErrorResponse(
          error,
          ErrorCode.E_UNKNOWN,
          args.path ?? args.paths?.[0]
        ),
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    progressMessage: (args) => {
      if (args.path && !args.paths?.length) {
        return `🛠 mkdir: ${path.basename(args.path)}`;
      }
      const count = (args.path ? 1 : 0) + (args.paths?.length ?? 0);
      return `🛠 mkdir: ${count} directories`;
    },
    completionMessage: (args, result) => {
      if (args.path && !args.paths?.length) {
        const name = path.basename(args.path);
        if (result.isError) return `🛠 mkdir: ${name} • failed`;
        return `🛠 mkdir: ${name}`;
      }
      const count = (args.path ? 1 : 0) + (args.paths?.length ?? 0);
      if (result.isError) return `🛠 mkdir: ${count} directories • failed`;
      return `🛠 mkdir: ${count} directories`;
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
