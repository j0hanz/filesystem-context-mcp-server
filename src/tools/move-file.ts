import type { McpServer } from '@modelcontextprotocol/server';

import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import type { z } from 'zod';

import { withAbort } from '../lib/abort.js';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  isNodeError,
  McpError,
} from '../lib/errors.js';
import { Logger } from '../lib/logger.js';
import {
  assertAllowedFileAccess,
  validateExistingPath,
  validatePathForWrite,
} from '../lib/paths.js';

import { MoveFileInputSchema, MoveFileOutputSchema } from '../schemas.js';
import { FILE_MOVE_ICONS } from './icons.js';
import {
  buildStructuredError,
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
  icons: FILE_MOVE_ICONS,
  gotchas: [
    'On POSIX, an existing destination is silently overwritten; on Windows, rename fails with EEXIST if destination exists.',
  ],
  taskSupport: 'forbidden',
} as const;

function toMoveFailure(
  source: string,
  error: unknown,
  defaultCode: ErrorCode = ErrorCode.UNKNOWN
): NonNullable<z.infer<typeof MoveFileOutputSchema>['failed']>[number] {
  return {
    source,
    error: buildStructuredError(error, defaultCode, source),
  };
}

async function handleMoveError(
  error: unknown,
  src: string,
  validSource: string,
  targetPath: string,
  movedSources: string[],
  failed: NonNullable<z.infer<typeof MoveFileOutputSchema>['failed']>,
  signal?: AbortSignal
): Promise<void> {
  if (isNodeError(error) && error.code === 'EXDEV') {
    try {
      await withAbort(cp(validSource, targetPath, { recursive: true }), signal);
    } catch (copyError) {
      failed.push(toMoveFailure(src, copyError));
      return;
    }
    try {
      await withAbort(
        rm(validSource, { recursive: true, force: true }),
        signal
      );
      movedSources.push(validSource);
    } catch (deleteError) {
      try {
        await rm(targetPath, { recursive: true, force: true });
      } catch {
        failed.push(
          toMoveFailure(
            src,
            new McpError(
              ErrorCode.UNKNOWN,
              `Cross-device move partial: data at both source and destination. ${formatUnknownErrorMessage(deleteError)}`,
              src
            )
          )
        );
        return;
      }
      failed.push(
        toMoveFailure(
          src,
          new McpError(
            ErrorCode.UNKNOWN,
            `Cross-device move failed: source not removed. ${formatUnknownErrorMessage(deleteError)}`,
            src
          )
        )
      );
    }
  } else {
    failed.push(toMoveFailure(src, error));
  }
}

async function processSingleMove(
  src: string,
  destIsDirectory: boolean,
  validDest: string,
  movedSources: string[],
  failed: NonNullable<z.infer<typeof MoveFileOutputSchema>['failed']>,
  signal?: AbortSignal
): Promise<void> {
  let validSource: string;
  try {
    validSource = await validateExistingPath(src, signal);
    assertAllowedFileAccess(src, validSource);
  } catch (error) {
    failed.push(toMoveFailure(src, error, ErrorCode.ACCESS_DENIED));
    return;
  }

  const targetPath = destIsDirectory
    ? join(validDest, basename(validSource))
    : validDest;

  if (resolve(validSource) === resolve(targetPath)) {
    return;
  }

  if (resolve(targetPath).startsWith(resolve(validSource) + sep)) {
    failed.push(
      toMoveFailure(
        src,
        new McpError(
          ErrorCode.INVALID_INPUT,
          'Cannot move a directory into its own subdirectory',
          src
        ),
        ErrorCode.INVALID_INPUT
      )
    );
    return;
  }

  try {
    await withAbort(rename(validSource, targetPath), signal);
    movedSources.push(validSource);
  } catch (error: unknown) {
    await handleMoveError(
      error,
      src,
      validSource,
      targetPath,
      movedSources,
      failed,
      signal
    );
  }
}

async function getDestinationStatus(validDest: string): Promise<boolean> {
  try {
    const stats = await stat(validDest);
    return stats.isDirectory();
  } catch (error) {
    if (isNodeError(error) && error.code !== 'ENOENT') {
      throw error;
    }
  }
  return false;
}

function formatMoveMessage(
  moved: number,
  failed: number,
  destination: string
): string {
  const movedItemStr = `item${moved === 1 ? '' : 's'}`;
  const failedItemStr = `item${failed === 1 ? '' : 's'}`;
  if (failed > 0) {
    return `Moved ${moved} ${movedItemStr}; failed to move ${failed} ${failedItemStr}`;
  }
  return `Successfully moved ${moved} ${movedItemStr} to ${destination}`;
}

async function handleMoveFile(
  args: z.infer<typeof MoveFileInputSchema>,
  signal?: AbortSignal
): Promise<ToolResponse<z.infer<typeof MoveFileOutputSchema>>> {
  const sources = args.sources ?? (args.source ? [args.source] : []);
  if (sources.length === 0) {
    throw new McpError(ErrorCode.INVALID_INPUT, 'No sources provided.');
  }

  const validDest = await validatePathForWrite(args.destination, signal);
  const destIsDirectory = await getDestinationStatus(validDest);

  if (sources.length > 1 && !destIsDirectory) {
    throw new McpError(
      ErrorCode.INVALID_INPUT,
      'Destination must be an existing directory for multiple sources.'
    );
  }

  if (!destIsDirectory) {
    await withAbort(mkdir(dirname(validDest), { recursive: true }), signal);
  }

  const movedSources: string[] = [];
  const failed: NonNullable<z.infer<typeof MoveFileOutputSchema>['failed']> =
    [];

  for (const src of sources) {
    await processSingleMove(
      src,
      destIsDirectory,
      validDest,
      movedSources,
      failed,
      signal
    );
  }

  const message = formatMoveMessage(
    movedSources.length,
    failed.length,
    args.destination
  );
  const movedSource = sources.length === 1 ? movedSources[0] : undefined;
  const failedSuffix = failed.length > 0 ? ` (${failed.length} failed)` : '';
  Logger.info(
    `mv: ${movedSources.length} item(s) → ${args.destination}${failedSuffix}`
  );

  if (movedSources.length === 0 && failed.length > 0) {
    const firstFailure = failed[0];
    if (firstFailure) {
      throw new McpError(
        firstFailure.error.code as ErrorCode,
        message,
        firstFailure.error.path
      );
    }
  }

  return buildToolResponse(message, {
    ok: failed.length === 0,
    ...(movedSource ? { source: movedSource } : {}),
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
      outputSchema: MoveFileOutputSchema,
      timedSignal: {},
      context: { path: args.source ?? args.sources?.[0] },
      run: (signal) => handleMoveFile(args, signal),
      onError: (error) =>
        buildToolErrorResponse(
          error,
          ErrorCode.UNKNOWN,
          args.source ?? args.sources?.[0]
        ),
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    progressMessage: (args) => {
      const dest = basename(args.destination);
      if (args.source && !args.sources?.length) {
        return `🛠 mv: ${basename(args.source)} → ${dest}`;
      }
      const count = (args.source ? 1 : 0) + (args.sources?.length ?? 0);
      return `🛠 mv: ${count} items → ${dest}`;
    },
    completionMessage: (args, result) => {
      const dest = basename(args.destination);
      if (args.source && !args.sources?.length) {
        const src = basename(args.source);
        if (result.isError) return `🛠 mv: ${src} → ${dest} • failed`;
        return `🛠 mv: ${src} → ${dest}`;
      }
      const count = (args.source ? 1 : 0) + (args.sources?.length ?? 0);
      if (result.isError) return `🛠 mv: ${count} items → ${dest} • failed`;
      return `🛠 mv: ${count} items → ${dest}`;
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
