import type {
  ElicitRequestFormParams,
  ElicitResult,
  McpServer,
} from '@modelcontextprotocol/server';

import { lstat, rm, rmdir } from 'node:fs/promises';
import { basename } from 'node:path';

import type { z } from 'zod/v4';

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
} from './shared.js';
import { registerStandardTool } from './task-support.js';

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
  signal?: AbortSignal,
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>
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

  // Ask for confirmation when deleting a directory recursively and client supports it.
  if (elicitInput && args.recursive && stats.isDirectory()) {
    const elicitResult = await elicitInput({
      mode: 'form',
      message: `Permanently delete "${args.path}" and all its contents? This cannot be undone.`,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            title: 'Yes, delete permanently',
          },
        },
        required: ['confirm'],
      },
    });

    if (
      elicitResult.action !== 'accept' ||
      elicitResult.content?.confirm !== true
    ) {
      return buildToolResponse(`Deletion cancelled: ${args.path}`, {
        ok: true,
        path: validPath,
      });
    }
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
      run: async (signal) => {
        // Only pass elicitInput when the connected client advertised elicitation support.
        const caps = server.server.getClientCapabilities();
        const elicitFn =
          caps?.elicitation && ctx.elicitInput ? ctx.elicitInput : undefined;
        const result = await handleDeleteFile(args, signal, elicitFn);
        void ctx.log?.('info', `rm: ${args.path}`, 'rm');
        return result;
      },
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

  registerStandardTool(server, DELETE_FILE_TOOL, handler, options, {
    progressMessage: (args) =>
      `${DELETE_FILE_TOOL.title}: ${basename(args.path)}`,
    completionMessage: (args, result) => {
      const name = basename(args.path);
      if (result.isError)
        return `${DELETE_FILE_TOOL.title}: ${name} • ${result.errorCode}`;
      return `${DELETE_FILE_TOOL.title}: ${name}`;
    },
  });
}
