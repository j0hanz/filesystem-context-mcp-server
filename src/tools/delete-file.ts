import type {
  ElicitRequestFormParams,
  ElicitResult,
} from '@modelcontextprotocol/server';

import { lstat, rm, rmdir } from 'node:fs/promises';

import type { z } from 'zod/v4';

import { withAbort } from '../lib/abort.js';
import { ErrorCode, isNodeError, McpError } from '../lib/errors.js';
import { Logger } from '../lib/logger.js';
import { isAllowedDirectoryRoot, validatePathForWrite } from '../lib/paths.js';
import { DeleteInputSchema } from '../schemas/inputs.js';
import { DeleteOutputSchema } from '../schemas/outputs.js';

import { buildPathMessages, defineTool } from './define-tool.js';
import { FILE_DELETE_ICONS } from './icons.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  type ToolContract,
} from './shared.js';

const DELETE_FILE_TOOL: ToolContract = {
  name: 'rm',
  title: 'Delete File',
  description:
    'Permanently delete a file or directory. This action is irreversible.',
  inputSchema: DeleteInputSchema,
  outputSchema: DeleteOutputSchema,
  annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  icons: FILE_DELETE_ICONS,
  gotchas: ['Non-empty directories require `recursive=true`.'],
  taskSupport: 'forbidden',
} as const;

async function handleDeleteFile(
  args: z.infer<typeof DeleteInputSchema>,
  signal?: AbortSignal,
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>
): Promise<z.infer<typeof DeleteOutputSchema>> {
  const validPath = await validatePathForWrite(args.path, signal);

  if (isAllowedDirectoryRoot(validPath)) {
    throw new McpError(
      ErrorCode.ACCESS_DENIED,
      'Deleting a workspace root directory is not allowed'
    );
  }

  let itemStats: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    itemStats = await withAbort(lstat(validPath), signal);
  } catch (error) {
    if (
      isNodeError(error) &&
      error.code === 'ENOENT' &&
      args.ignoreIfNotExists
    ) {
      return {
        ok: true,
        path: validPath,
      };
    }
    throw error;
  }

  const itemType = itemStats.isDirectory()
    ? 'directory'
    : itemStats.isSymbolicLink()
      ? 'symlink'
      : itemStats.isFile()
        ? 'file'
        : 'other';

  // Ask for confirmation when deleting a directory recursively and client supports it.
  if (elicitInput && args.recursive && itemStats.isDirectory()) {
    try {
      const elicitResult = await elicitInput({
        mode: 'form',
        message: `Permanently delete "${args.path}" and all its contents? This cannot be undone.`,
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: { type: 'boolean', title: 'Yes, delete permanently' },
          },
          required: ['confirm'],
        },
      });

      if (
        elicitResult.action !== 'accept' ||
        elicitResult.content?.confirm !== true
      ) {
        return {
          ok: true,
          path: validPath,
          type: itemType,
        };
      }
    } catch {
      // Client doesn't support form elicitation, proceed without asking
    }
  }

  if (itemStats.isDirectory() && !args.recursive) {
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

  return {
    ok: true,
    path: validPath,
    type: itemType,
  };
}

type DeleteInput = z.infer<typeof DeleteInputSchema>;
type DeleteOutput = z.infer<typeof DeleteOutputSchema>;

const deleteMessages = buildPathMessages<DeleteInput, DeleteOutput>(
  DELETE_FILE_TOOL.title
);

export const DELETE_FILE = defineTool<DeleteInput, DeleteOutput>({
  contract: DELETE_FILE_TOOL,
  run: async (args, ctx) => {
    const structured = await handleDeleteFile(
      args,
      ctx.signal,
      ctx.elicitInput
    );
    const text = `Successfully deleted: ${args.path}`;
    void ctx.log?.('info', `rm: ${args.path}`, 'rm');
    return buildToolResponse(text, structured);
  },
  ...deleteMessages,
  onError: (error, args) => {
    if (isNodeError(error)) {
      if (error.code === 'ENOENT') {
        return buildToolErrorResponse(error, ErrorCode.NOT_FOUND, args.path);
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
