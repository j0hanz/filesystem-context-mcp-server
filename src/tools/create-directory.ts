import * as fs from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode, McpError } from '../lib/errors.js';
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

export async function handleCreateDirectory(
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
      const count = (args.path ? 1 : 0) + (args.paths?.length ?? 0);
      return `🛠 mkdir: ${count} director${count === 1 ? 'y' : 'ies'}`;
    },
    completionMessage: (args, result) => {
      const count = (args.path ? 1 : 0) + (args.paths?.length ?? 0);
      if (result.isError) return `🛠 mkdir: ${count} • failed`;
      return `🛠 mkdir: ${count} • created`;
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
