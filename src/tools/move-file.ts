import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/server';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/server';

import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { z } from 'zod/v4';

import { withAbort } from '../core/concurrency.js';
import { ErrorCode, isNodeError, McpError } from '../core/errors.js';
import { Logger } from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import { RequiredPath } from '../schema.js';
import { buildToolResponse } from './_helpers.js';
import { defineTool } from './define.js';

const MoveFileInputSchema = z.strictObject({
  sources: z.array(RequiredPath).min(1).describe('One or more source paths to move'),
  destination: RequiredPath.describe('Destination path'),
});

const MoveFileOutputSchema = z.strictObject({
  from: z.string().describe('Resolved source path'),
  to: z.string().describe('Resolved destination path'),
  ok: z.literal(true).describe('Success indicator'),
});

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

async function tryElicitOverwriteConfirmation(
  destination: string,
  validDest: string,
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>,
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

    if (elicitResult.action !== 'accept' || elicitResult.content?.confirmOverwrite !== true) {
      // User declined — surface as a cancellation error.
      throw new McpError(
        ErrorCode.CANCELLED,
        `Move cancelled: "${destination}" already exists and overwrite was declined.`,
      );
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    if (err instanceof SdkError && err.code === SdkErrorCode.CapabilityNotSupported) {
      // Client doesn't support elicitation — proceed without asking.
    } else {
      // Transport or unexpected failure — fail closed, don't move.
      throw new McpError(
        ErrorCode.CANCELLED,
        `Move cancelled: could not confirm overwrite of "${destination}".`,
      );
    }
  }
}

async function handleMoveFile(
  args: z.infer<typeof MoveFileInputSchema>,
  pathGuard: PathGuard,
  signal?: AbortSignal,
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>,
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
      'Destination must be an existing directory for multiple sources.',
    );
  }

  if (!destIsDirectory) {
    await withAbort(mkdir(dirname(validDest), { recursive: true }), signal);
  }

  if (sources.length === 1 && !destIsDirectory) {
    await tryElicitOverwriteConfirmation(args.destination, validDest, elicitInput);
  }

  const movedSources: string[] = [];

  for (const src of sources) {
    // For P3 confirmation-only pattern, we track moves but throw on first error
    let validSource: string;
    try {
      validSource = await pathGuard.validateExistingPath(src);
      pathGuard.assertAllowedFileAccess(src);
    } catch (error) {
      throw new McpError(
        error instanceof McpError ? error.code : ErrorCode.ACCESS_DENIED,
        `Move failed for ${src}`,
        src,
      );
    }

    const targetPath = destIsDirectory ? join(validDest, basename(validSource)) : validDest;

    if (resolve(validSource) === resolve(targetPath)) {
      continue;
    }

    if (resolve(targetPath).startsWith(resolve(validSource) + sep)) {
      throw new McpError(
        ErrorCode.INVALID_INPUT,
        'Cannot move a directory into its own subdirectory',
        src,
      );
    }

    try {
      await withAbort(rename(validSource, targetPath), signal);
      movedSources.push(validSource);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'EXDEV') {
        // Handle cross-device move
        try {
          await withAbort(cp(validSource, targetPath, { recursive: true }), signal);
          await withAbort(rm(validSource, { recursive: true, force: true }), signal);
          movedSources.push(validSource);
        } catch (_crossDeviceError) {
          throw new McpError(ErrorCode.UNKNOWN, `Cross-device move failed for ${src}`, src);
        }
      } else {
        throw new McpError(ErrorCode.UNKNOWN, `Move failed for ${src}`, src);
      }
    }
  }

  const firstSource = movedSources[0];
  if (!firstSource) {
    throw new McpError(ErrorCode.UNKNOWN, 'No sources were moved');
  }

  Logger.info(`mv: ${movedSources.length} item(s) → ${args.destination}`);

  // P3 confirmation-only pattern: return simplified response with from/to/ok
  return {
    ok: true as const,
    from: firstSource,
    to: validDest,
  };
}

export const MOVE_FILE = defineTool({
  name: 'move',
  title: 'Move File',
  description: 'Move or rename one or more files/directories to a destination.',
  input: MoveFileInputSchema,
  output: MoveFileOutputSchema,
  annotations: 'destructiveWrite',
  gotchas: [
    'On POSIX, an existing destination is silently overwritten; on Windows, rename fails with EEXIST if destination exists.',
  ],
  progressLabel: (args) => {
    const dest = basename(args.destination);
    if (args.sources.length === 1) {
      return `Move File: ${basename(args.sources[0] ?? '')} \u2192 ${dest}`;
    }
    return `Move File: ${args.sources.length} items \u2192 ${dest}`;
  },
  defaultErrorCode: ErrorCode.UNKNOWN,
  run: async (args, ctx) => {
    const structured = await handleMoveFile(args, ctx.pathGuard, ctx.signal, ctx.elicitInput);
    ctx.log?.('info', `mv: ${args.sources.join(', ')} \u2192 ${args.destination}`, 'mv');
    const summary = `move-file: ${structured.from} \u2192 ${structured.to}`;
    return buildToolResponse(summary, structured);
  },
});
