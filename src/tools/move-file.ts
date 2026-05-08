import type {
  ElicitRequestFormParams,
  ElicitResult,
} from '@modelcontextprotocol/server';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/server';

import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { z } from 'zod/v4';

import { withAbort } from '../lib/abort.js';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  isNodeError,
  McpError,
} from '../lib/errors.js';
import { Logger } from '../lib/logger.js';
import type { PathGuard } from '../lib/path-guard.js';
import { RequiredPath } from '../schemas/fields.js';
import { PerFileErrorSchema } from '../schemas/shared.js';

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

const MoveFileInputSchema = z.strictObject({
  sources: z
    .array(RequiredPath)
    .min(1)
    .describe('One or more source paths to move'),
  destination: RequiredPath.describe('Destination path'),
});

const MoveFileOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  source: z
    .string()
    .optional()
    .describe('Resolved source (single-source moves)'),
  sources: z.array(z.string()).describe('Resolved sources that were moved'),
  destination: z.string().describe('Resolved destination'),
  failed: z
    .array(
      z.strictObject({
        source: z.string().describe('Failed source path'),
        error: PerFileErrorSchema.describe('Failure details'),
      })
    )
    .optional()
    .describe('Failed moves (partial failure)'),
});

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

async function handleCrossDeviceMove(
  src: string,
  validSource: string,
  targetPath: string,
  movedSources: string[],
  failed: NonNullable<z.infer<typeof MoveFileOutputSchema>['failed']>,
  signal?: AbortSignal
): Promise<void> {
  try {
    await withAbort(cp(validSource, targetPath, { recursive: true }), signal);
  } catch (copyError) {
    failed.push(toMoveFailure(src, copyError));
    return;
  }
  try {
    await withAbort(rm(validSource, { recursive: true, force: true }), signal);
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
    await handleCrossDeviceMove(
      src,
      validSource,
      targetPath,
      movedSources,
      failed,
      signal
    );
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
  pathGuard: PathGuard,
  signal?: AbortSignal
): Promise<void> {
  let validSource: string;
  try {
    validSource = await pathGuard.validateExistingPath(src);
    pathGuard.assertAllowedFileAccess(src);
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

async function tryElicitOverwriteConfirmation(
  destination: string,
  validDest: string,
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>
): Promise<void> {
  if (!elicitInput) return;

  let destExists = false;
  try {
    await stat(validDest);
    destExists = true;
  } catch {
    // Destination does not exist — no confirmation needed.
  }

  if (!destExists) return;

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
      // User declined — surface as a cancellation error.
      throw new McpError(
        ErrorCode.CANCELLED,
        `Move cancelled: "${destination}" already exists and overwrite was declined.`
      );
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    if (
      err instanceof SdkError &&
      err.code === SdkErrorCode.CapabilityNotSupported
    ) {
      // Client doesn't support elicitation — proceed without asking.
    } else {
      // Transport or unexpected failure — fail closed, don't move.
      throw new McpError(
        ErrorCode.CANCELLED,
        `Move cancelled: could not confirm overwrite of "${destination}".`
      );
    }
  }
}

async function handleMoveFile(
  args: z.infer<typeof MoveFileInputSchema>,
  pathGuard: PathGuard,
  signal?: AbortSignal,
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>
): Promise<z.infer<typeof MoveFileOutputSchema>> {
  const sources = args.sources;
  if (sources.length === 0) {
    throw new McpError(ErrorCode.INVALID_INPUT, 'No sources provided.');
  }

  const validDest = await pathGuard.validatePathForWrite(args.destination);
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

  if (sources.length === 1 && !destIsDirectory) {
    await tryElicitOverwriteConfirmation(
      args.destination,
      validDest,
      elicitInput
    );
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
      pathGuard,
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
    const structured = await handleMoveFile(
      args,
      ctx.pathGuard,
      ctx.signal,
      ctx.elicitInput
    );
    const message = formatMoveMessage(
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
