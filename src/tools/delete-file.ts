import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { z } from 'zod';

import { withAbort } from '../lib/abort.js';
import { ErrorCode, isNodeError, McpError } from '../lib/errors.js';
import { Logger } from '../lib/logger.js';
import { isAllowedDirectoryRoot, validatePathForWrite } from '../lib/paths.js';

import { DeleteFileInputSchema, DeleteFileOutputSchema } from '../schemas.js';
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

export const DELETE_FILE_TOOL: ToolContract = {
  name: 'rm',
  title: 'Delete File',
  description:
    'Permanently delete a file or directory. This action is irreversible.',
  inputSchema: DeleteFileInputSchema,
  outputSchema: DeleteFileOutputSchema,
  annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
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
      ErrorCode.E_ACCESS_DENIED,
      `Deleting a workspace root directory is not allowed: ${args.path}`
    );
  }

  let stats: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    stats = await withAbort(fs.lstat(validPath), signal);
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
    await withAbort(fs.rmdir(validPath), signal);
  } else {
    await withAbort(
      fs.rm(validPath, {
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
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof DeleteFileOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'rm',
      extra,
      outputSchema: DeleteFileOutputSchema,
      timedSignal: {},
      context: { path: args.path },
      run: (signal) => handleDeleteFile(args, signal),
      onError: (error) => {
        if (isNodeError(error)) {
          if (error.code === 'ENOENT') {
            return buildToolErrorResponse(
              error,
              ErrorCode.E_NOT_FOUND,
              args.path
            );
          }
          if (error.code === 'ENOTEMPTY') {
            return buildToolErrorResponse(
              new Error(
                `Directory is not empty: ${args.path}. Use recursive: true to delete non-empty directories.`
              ),
              ErrorCode.E_INVALID_INPUT,
              args.path
            );
          }
          if (error.code === 'EISDIR') {
            return buildToolErrorResponse(
              new Error(
                `Path is a directory: ${args.path}. Use recursive: true to delete directories.`
              ),
              ErrorCode.E_INVALID_INPUT,
              args.path
            );
          }
          if (error.code === 'EEXIST') {
            return buildToolErrorResponse(
              new Error(
                `Directory is not empty: ${args.path}. Use recursive: true to delete non-empty directories.`
              ),
              ErrorCode.E_INVALID_INPUT,
              args.path
            );
          }
          if (error.code === 'EPERM' || error.code === 'EACCES') {
            return buildToolErrorResponse(
              error,
              ErrorCode.E_PERMISSION_DENIED,
              args.path
            );
          }
        }
        return buildToolErrorResponse(error, ErrorCode.E_UNKNOWN, args.path);
      },
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    progressMessage: (args) => `🛠 rm: ${path.basename(args.path)}`,
    completionMessage: (args, result) => {
      const name = path.basename(args.path);
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
