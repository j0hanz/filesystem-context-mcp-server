import type { McpServer } from '@modelcontextprotocol/server';

import { lstat, rm, rmdir } from 'node:fs/promises';
import { basename } from 'node:path';

import type { z } from 'zod';

import { withAbort } from '../lib/abort.js';
import { ErrorCode, isNodeError, McpError } from '../lib/errors.js';
import { Logger } from '../lib/logger.js';
import { isAllowedDirectoryRoot, validatePathForWrite } from '../lib/paths.js';

import { DeleteFileInputSchema, DeleteFileOutputSchema } from '../schemas.js';
import { FILE_DELETE_ICONS } from './icons.js';
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
  withDefaultIcons,
  withValidatedArgs,
  wrapToolHandler,
} from './shared.js';
import { registerToolTaskIfAvailable } from './task-support.js';

export const DELETE_FILE_TOOL: ToolContract = {
  name: 'rm',
  title: 'Delete File',
  description:
    'Permanently delete a file or directory. This action is irreversible.',
  inputSchema: DeleteFileInputSchema,
  outputSchema: DeleteFileOutputSchema,
  annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  icons: FILE_DELETE_ICONS,
  gotchas: ['Non-empty directories require `recursive=true`.'],
  taskSupport: 'forbidden',
} as const;

async function handleDeleteFile(
  args: z.infer<typeof DeleteFileInputSchema>,
  signal?: AbortSignal
): Promise<ToolResponse<z.infer<typeof DeleteFileOutputSchema>>> {
  const validPath = await validatePathForWrite(args.path, signal);

  if (isAllowedDirectoryRoot(validPath)) {
    throw new McpError(
      ErrorCode.ACCESS_DENIED,
      'Deleting a workspace root directory is not allowed'
    );
  }

  let stats: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    stats = await withAbort(lstat(validPath), signal);
  } catch (error) {
    if (
      isNodeError(error) &&
      error.code === 'ENOENT' &&
      args.ignoreIfNotExists
    ) {
      return buildToolResponse(`Successfully deleted: ${args.path}`, {
        ok: true,
        path: validPath,
      });
    }
    throw error;
  }

  if (stats.isDirectory() && !args.recursive) {
    // Use rmdir for non-recursive directory deletes so non-empty directories
    // consistently return ENOTEMPTY-style errors with actionable guidance.
    await withAbort(rmdir(validPath), signal);
  } else {
    await withAbort(
      rm(validPath, {
        recursive: args.recursive,
        force: args.ignoreIfNotExists,
      }),
      signal
    );
  }

  Logger.info(`rm: ${args.path}`);

  return buildToolResponse(`Successfully deleted: ${args.path}`, {
    ok: true,
    path: validPath,
  });
}

export function registerDeleteFileTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof DeleteFileInputSchema>,
    ctx: ToolContext
  ): Promise<ToolResult<z.infer<typeof DeleteFileOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'rm',
      ctx,
      outputSchema: DeleteFileOutputSchema,
      timedSignal: {},
      context: { path: args.path },
      run: (signal) => handleDeleteFile(args, signal),
      onError: (error) => {
        if (isNodeError(error)) {
          if (error.code === 'ENOENT') {
            return buildToolErrorResponse(
              error,
              ErrorCode.NOT_FOUND,
              args.path
            );
          }
          if (error.code === 'ENOTEMPTY') {
            return buildToolErrorResponse(
              new Error('Directory not empty. Set recursive: true.'),
              ErrorCode.INVALID_INPUT,
              args.path
            );
          }
          if (error.code === 'EISDIR') {
            return buildToolErrorResponse(
              new Error('Path is a directory. Set recursive: true.'),
              ErrorCode.INVALID_INPUT,
              args.path
            );
          }
          if (error.code === 'EEXIST') {
            return buildToolErrorResponse(
              new Error('Directory not empty. Set recursive: true.'),
              ErrorCode.INVALID_INPUT,
              args.path
            );
          }
          if (error.code === 'EPERM' || error.code === 'EACCES') {
            return buildToolErrorResponse(
              error,
              ErrorCode.PERMISSION_DENIED,
              args.path
            );
          }
        }
        return buildToolErrorResponse(error, ErrorCode.UNKNOWN, args.path);
      },
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    progressMessage: (args) => `🛠 rm: ${basename(args.path)}`,
    completionMessage: (args, result) => {
      const name = basename(args.path);
      if (result.isError) return `🛠 rm: ${name} • failed`;
      return `🛠 rm: ${name}`;
    },
  });

  const validatedHandler = withValidatedArgs(
    DeleteFileInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      'rm',
      DELETE_FILE_TOOL,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  )
    return;
  server.registerTool(
    'rm',
    withDefaultIcons({ ...DELETE_FILE_TOOL }, options.iconInfo),
    validatedHandler
  );
}
