import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import {
  ErrorCode,
  formatUnknownErrorMessage,
  isNodeError,
  McpError,
} from '../lib/errors.js';
import { withAbort } from '../lib/fs-helpers.js';
import {
  validateExistingPath,
  validatePathForWrite,
} from '../lib/path-validation.js';
import { MoveFileInputSchema, MoveFileOutputSchema } from '../schemas.js';
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

export const MOVE_FILE_TOOL: ToolContract = {
  name: 'mv',
  title: 'Move File',
  description: 'Move or rename a file or directory.',
  inputSchema: MoveFileInputSchema,
  outputSchema: MoveFileOutputSchema,
  annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  nuances: ['Cross-device moves fall back to copy+delete.'],
  gotchas: [
    'On POSIX, an existing destination is silently overwritten; on Windows, rename fails with EEXIST if destination exists.',
  ],
} as const;

export async function handleMoveFile(
  args: z.infer<typeof MoveFileInputSchema>,
  signal?: AbortSignal
): Promise<ToolResponse<z.infer<typeof MoveFileOutputSchema>>> {
  const sources = args.sources ?? (args.source ? [args.source] : []);
  if (sources.length === 0) {
    throw new McpError(ErrorCode.E_INVALID_INPUT, 'No sources provided.');
  }

  const validDest = await validatePathForWrite(args.destination, signal);

  // Check if destination exists and is a directory
  let destIsDirectory = false;
  try {
    const stats = await fs.stat(validDest);
    destIsDirectory = stats.isDirectory();
  } catch (error) {
    if (isNodeError(error) && error.code !== 'ENOENT') {
      throw error;
    }
  }

  if (sources.length > 1 && !destIsDirectory) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Destination must be an existing directory when moving multiple files.'
    );
  }

  // Ensure destination parent directory exists if it's not an existing directory
  if (!destIsDirectory) {
    await withAbort(
      fs.mkdir(path.dirname(validDest), { recursive: true }),
      signal
    );
  }

  const movedSources: string[] = [];
  const failed: { source: string; error: string }[] = [];

  for (const src of sources) {
    let validSource: string;
    try {
      validSource = await validateExistingPath(src, signal);
    } catch (error) {
      failed.push({
        source: src,
        error: formatUnknownErrorMessage(error),
      });
      continue;
    }

    const targetPath = destIsDirectory
      ? path.join(validDest, path.basename(validSource))
      : validDest;

    // Prevent moving a file onto itself
    if (path.resolve(validSource) === path.resolve(targetPath)) {
      continue;
    }

    // Prevent moving a directory into its own subdirectory
    // Fixes "Missing validation for moving directory into its own subdirectory" finding
    if (
      path.resolve(targetPath).startsWith(path.resolve(validSource) + path.sep)
    ) {
      failed.push({
        source: src,
        error: `Cannot move directory '${src}' into its own subdirectory '${targetPath}'`,
      });
      continue;
    }

    try {
      await withAbort(fs.rename(validSource, targetPath), signal);
      movedSources.push(validSource);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'EXDEV') {
        // Cross-device link, fallback to copy + delete
        try {
          await withAbort(
            fs.cp(validSource, targetPath, { recursive: true }),
            signal
          );
          await withAbort(
            fs.rm(validSource, { recursive: true, force: true }),
            signal
          );
          movedSources.push(validSource);
        } catch (copyError) {
          failed.push({
            source: src,
            error: formatUnknownErrorMessage(copyError),
          });
        }
      } else {
        failed.push({
          source: src,
          error: formatUnknownErrorMessage(error),
        });
      }
    }
  }

  const message =
    failed.length > 0
      ? `Moved ${movedSources.length} item${movedSources.length === 1 ? '' : 's'}; failed to move ${failed.length} item${failed.length === 1 ? '' : 's'}`
      : `Successfully moved ${movedSources.length} item${movedSources.length === 1 ? '' : 's'} to ${args.destination}`;

  return buildToolResponse(message, {
    ok: failed.length === 0,
    sources: movedSources,
    destination: validDest,
    ...(failed.length > 0 ? { failed } : {}),
  });
}

export function registerMoveFileTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof MoveFileInputSchema>,
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof MoveFileOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'mv',
      extra,
      timedSignal: {},
      context: { path: args.source ?? args.sources?.[0] },
      run: (signal) => handleMoveFile(args, signal),
      onError: (error) =>
        buildToolErrorResponse(
          error,
          ErrorCode.E_UNKNOWN,
          args.source ?? args.sources?.[0]
        ),
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    progressMessage: (args) => {
      const count = (args.source ? 1 : 0) + (args.sources?.length ?? 0);
      const dest = path.basename(args.destination);
      return `🛠 mv: ${count} item${count === 1 ? '' : 's'} → ${dest}`;
    },
    completionMessage: (args, result) => {
      const count = (args.source ? 1 : 0) + (args.sources?.length ?? 0);
      const dest = path.basename(args.destination);
      if (result.isError) return `🛠 mv: ${count} → ${dest} • failed`;
      return `🛠 mv: ${count} → ${dest} • moved`;
    },
  });

  const validatedHandler = withValidatedArgs(
    MoveFileInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      'mv',
      MOVE_FILE_TOOL,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  )
    return;
  server.registerTool(
    'mv',
    withDefaultIcons({ ...MOVE_FILE_TOOL }, options.iconInfo),
    validatedHandler
  );
}
