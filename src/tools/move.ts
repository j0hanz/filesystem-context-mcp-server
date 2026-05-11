import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/server';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/server';

import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';

import { z } from 'zod/v4';

import { withAbort } from '../core/concurrency.js';
import { ErrorCode, isNodeError, McpError } from '../core/errors.js';
import type { PathGuard } from '../core/path.js';
import { RequiredPath } from '../schema.js';
import { buildToolResponse } from './_helpers.js';
import { defineTool } from './define.js';

const MoveItemSchema = z.strictObject({
  source: RequiredPath.describe('Source path to move'),
  destination: RequiredPath.describe('Destination path'),
});

const MoveItemResultSchema = z.strictObject({
  from: z.string().describe('Resolved source path'),
  to: z.string().describe('Resolved destination path'),
  ok: z.literal(true).describe('Success indicator'),
});

const MoveInputSchema = z.strictObject({
  moves: z.array(MoveItemSchema).min(1).max(100).describe('Move operations to perform'),
});

const MoveOutputSchema = z.strictObject({
  moves: z.array(MoveItemResultSchema).describe('Completed move operations'),
});

type MoveItemResult = z.infer<typeof MoveItemResultSchema>;

async function tryElicitOverwriteConfirmation(
  destination: string,
  validDest: string,
  signal: AbortSignal,
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>,
): Promise<void> {
  if (!elicitInput) return;

  let destExists = false;
  try {
    await withAbort(stat(validDest), signal);
    destExists = true;
  } catch {
    // Destination does not exist - no confirmation needed.
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

    if (elicitResult.action !== 'accept' || elicitResult.content?.['confirmOverwrite'] !== true) {
      // User declined - surface as a cancellation error.
      throw new McpError(
        ErrorCode.CANCELLED,
        `Move cancelled: "${destination}" already exists and overwrite was declined.`,
      );
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    if (err instanceof SdkError && err.code === SdkErrorCode.CapabilityNotSupported) {
      // Client doesn't support elicitation - proceed without asking.
    } else {
      // Transport or unexpected failure - fail closed, don't move.
      throw new McpError(
        ErrorCode.CANCELLED,
        `Move cancelled: could not confirm overwrite of "${destination}".`,
      );
    }
  }
}

function buildSummary(results: readonly MoveItemResult[]): string {
  if (results.length === 1) {
    const result = results[0];
    if (result) return `move: ${basename(result.from)} -> ${basename(result.to)}`;
  }

  return `move: ${String(results.length)} items`;
}

async function validateMoveSource(source: string, pathGuard: PathGuard): Promise<string> {
  try {
    const validSource = await pathGuard.validateExistingPath(source);
    pathGuard.assertAllowedFileAccess(source);
    return validSource;
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(ErrorCode.ACCESS_DENIED, `Move failed for ${source}`, source);
  }
}

async function performRenameWithFallback(
  validSource: string,
  validDest: string,
  signal: AbortSignal,
  originalSource: string,
): Promise<void> {
  try {
    await withAbort(rename(validSource, validDest), signal);
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== 'EXDEV') {
      throw new McpError(ErrorCode.UNKNOWN, `Move failed for ${originalSource}`, originalSource);
    }

    try {
      await withAbort(cp(validSource, validDest, { recursive: true }), signal);
      await withAbort(rm(validSource, { recursive: true, force: true }), signal);
    } catch {
      throw new McpError(
        ErrorCode.UNKNOWN,
        `Cross-device move failed for ${originalSource}`,
        originalSource,
      );
    }
  }
}

export const MOVE = defineTool({
  name: 'move',
  title: 'Move Files',
  description: 'Move or rename one or more files/directories to explicit destinations.',
  input: MoveInputSchema,
  output: MoveOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  gotchas: [
    'Existing destinations may be overwritten after confirmation when elicitation is available.',
    'If the client does not support elicitation, overwrite confirmation is skipped.',
    'Self-moves are skipped without error.',
  ],
  progressLabel: (args) => {
    if (args.moves.length === 1) {
      const move = args.moves[0];
      return `Move Files: ${basename(move?.source ?? '')} -> ${basename(move?.destination ?? '')}`;
    }
    return `Move Files: ${String(args.moves.length)} items`;
  },
  defaultErrorCode: ErrorCode.UNKNOWN,
  run: async (args, ctx) => {
    const results: MoveItemResult[] = [];

    for (const move of args.moves) {
      const validSource = await validateMoveSource(move.source, ctx.pathGuard);
      const validDest = await ctx.pathGuard.validatePathForWrite(move.destination);

      if (resolve(validSource) === resolve(validDest)) {
        continue;
      }

      if (resolve(validDest).startsWith(resolve(validSource) + sep)) {
        throw new McpError(
          ErrorCode.INVALID_INPUT,
          'Cannot move a directory into its own subdirectory',
          move.source,
        );
      }

      await withAbort(mkdir(dirname(validDest), { recursive: true }), ctx.signal);
      await tryElicitOverwriteConfirmation(
        move.destination,
        validDest,
        ctx.signal,
        ctx.elicitInput,
      );
      await performRenameWithFallback(validSource, validDest, ctx.signal, move.source);

      results.push({ ok: true as const, from: validSource, to: validDest });
      ctx.log?.('info', `move: ${move.source} -> ${move.destination}`, 'move');
    }

    return buildToolResponse(buildSummary(results), { moves: results });
  },
});
