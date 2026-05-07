import type {
  ElicitRequestFormParams,
  ElicitResult,
} from '@modelcontextprotocol/server';

import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import type { z } from 'zod/v4';

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
import { MoveFileInputSchema } from '../schemas/inputs.js';
import { MoveFileOutputSchema } from '../schemas/outputs.js';

import { defineTool } from './define-tool.js';
import { FILE_MOVE_ICONS } from './icons.js';
import {
  buildStructuredError,
  buildToolErrorResponse,
  buildToolResponse,
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  type ToolContract,
  type ToolResult,
} from './shared.js';

const MOVE_FILE_TOOL: ToolContract = {
  name: 'mv',
  title: 'Move File',
  description: 'Move or rename one or more files/directories to a destination.',
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
  signal?: AbortSignal,
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>
): Promise<z.infer<typeof MoveFileOutputSchema>> {
  const sources = args.sources;
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

  // For single-source moves, check if destination exists and elicit confirmation.
  // TODO: batch mv elicitation (sources.length > 1 path is deferred)
  if (elicitInput && sources.length === 1 && !destIsDirectory) {
    let destExists = false;
    try {
      await stat(validDest);
      destExists = true;
    } catch {
      // Destination does not exist — no confirmation needed.
    }

    if (destExists) {
      const destination = args.destination;
      try {
        const elicitResult = await elicitInput({
          mode: 'form',
          message: `"${destination}" already exists. Overwrite it?`,
          requestedSchema: {
            type: 'object',
            properties: {
              confirmOverwrite: {
                type: 'boolean',
                title: 'Yes, overwrite',
              },
            },
            required: ['confirmOverwrite'],
          },
        });

        if (
          elicitResult.action !== 'accept' ||
          elicitResult.content?.confirmOverwrite !== true
        ) {
          // Return early — do not move.
          return {
            ok: true as const,
            cancelled: true,
            sources: [],
            destination: validDest,
          };
        }
      } catch {
        // Client doesn't support form elicitation, proceed without asking.
      }
    }
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

  return {
    ok: true as const,
    ...(movedSource ? { source: movedSource } : {}),
    sources: movedSources,
    destination: validDest,
    ...(failed.length > 0 ? { failed } : {}),
  };
}

type MoveInput = z.infer<typeof MoveFileInputSchema>;
type MoveOutput = z.infer<typeof MoveFileOutputSchema>;

export const MOVE_FILE = defineTool<MoveInput, MoveOutput>({
  contract: MOVE_FILE_TOOL,
  run: async (args, ctx) => {
    const structured = await handleMoveFile(args, ctx.signal, ctx.elicitInput);
    const isCancelled = structured.cancelled === true;
    const message = isCancelled
      ? `Move cancelled: ${args.sources[0] ?? ''}`
      : formatMoveMessage(
          structured.sources.length,
          structured.failed?.length ?? 0,
          args.destination
        );
    void ctx.log?.(
      'info',
      `mv: ${args.sources.join(', ')} \u2192 ${args.destination}`,
      'mv'
    );
    return buildToolResponse(message, structured);
  },
  progressMessage: (args) => {
    const dest = basename(args.destination);
    if (args.sources.length === 1) {
      return `${MOVE_FILE_TOOL.title}: ${basename(args.sources[0] ?? '')} \u2192 ${dest}`;
    }
    return `${MOVE_FILE_TOOL.title}: ${args.sources.length} items \u2192 ${dest}`;
  },
  completionMessage: (
    args: MoveInput,
    result: ToolResult<MoveOutput>
  ): string => {
    const dest = basename(args.destination);
    if (args.sources.length === 1) {
      const src = basename(args.sources[0] ?? '');
      if (result.isError)
        return `${MOVE_FILE_TOOL.title}: ${src} \u2192 ${dest} \u2022 ${result.errorCode}`;
      return `${MOVE_FILE_TOOL.title}: ${src} \u2192 ${dest}`;
    }
    if (result.isError)
      return `${MOVE_FILE_TOOL.title}: ${args.sources.length} items \u2192 ${dest} \u2022 ${result.errorCode}`;
    return `${MOVE_FILE_TOOL.title}: ${args.sources.length} items \u2192 ${dest}`;
  },
  onError: (error, args) =>
    buildToolErrorResponse(error, ErrorCode.UNKNOWN, args.sources[0] ?? ''),
});
