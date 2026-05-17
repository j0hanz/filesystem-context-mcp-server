import type { PrimitiveSchemaDefinition } from '@modelcontextprotocol/server';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/server';

import { basename, dirname, resolve, sep } from 'node:path';

import { z } from 'zod/v4';

import { withAbort } from '../core/concurrency.js';
import { ErrorCode, FsError, isAbortError, isNodeError, Problem } from '../core/errors.js';
import { PerFileErrorSchema, RequiredPath } from '../schema.js';
import { defineTool, type ToolCtx, type ToolFsOps } from './define.js';

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

const MoveFailureItemSchema = z.strictObject({
  source: z.string().describe('Source path that failed'),
  destination: z.string().describe('Destination path for the failed move'),
  error: PerFileErrorSchema,
});

type MoveFailureItem = z.infer<typeof MoveFailureItemSchema>;

const MoveOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  moves: z.array(MoveItemResultSchema).describe('Completed move operations'),
  failures: z.array(MoveFailureItemSchema).optional().describe('Per-move errors'),
});

type MoveItemResult = z.infer<typeof MoveItemResultSchema>;

async function tryElicitOverwriteConfirmation(
  destination: string,
  validDest: string,
  ctx: Pick<ToolCtx, 'fs' | 'elicitInput'>,
): Promise<void> {
  if (!ctx.elicitInput) return;

  let destExists = false;
  try {
    await ctx.fs.stat(validDest);
    destExists = true;
  } catch {
    // Destination does not exist - no confirmation needed.
  }

  if (!destExists) return;

  try {
    const confirmOverwriteField: PrimitiveSchemaDefinition = {
      type: 'boolean',
      title: 'Yes, overwrite',
    };
    const elicitResult = await ctx.elicitInput({
      mode: 'form',
      message: `"${destination}" already exists. Overwrite it?`,
      requestedSchema: {
        type: 'object',
        properties: { confirmOverwrite: confirmOverwriteField },
        required: ['confirmOverwrite'],
      },
    });

    if (elicitResult.action !== 'accept' || elicitResult.content?.['confirmOverwrite'] !== true) {
      // User declined - surface as a cancellation error.
      throw new FsError(
        ErrorCode.CANCELLED,
        `Move cancelled: "${destination}" already exists and overwrite was declined.`,
      );
    }
  } catch (err) {
    if (err instanceof FsError) throw err;
    if (err instanceof SdkError && err.code === SdkErrorCode.CapabilityNotSupported) {
      // Client doesn't support elicitation - proceed without asking.
    } else {
      // Transport or unexpected failure - fail closed, don't move.
      throw new FsError(
        ErrorCode.CANCELLED,
        `Move cancelled: could not confirm overwrite of "${destination}".`,
      );
    }
  }
}

function buildSummary(
  results: readonly MoveItemResult[],
  failures: readonly MoveFailureItem[],
): string {
  const successCount = results.length;
  const failCount = failures.length;
  if (failCount === 0 && successCount === 1) {
    const result = results[0];
    if (result) {
      return `move: ${basename(result.from)} → ${basename(result.to)}`;
    }
  }
  const parts = [`move: ${String(successCount)} item${successCount === 1 ? '' : 's'}`];
  if (failCount > 0) parts.push(`${String(failCount)} failed`);
  return parts.join(' · ');
}

async function validateMoveSource(
  source: string,
  pathGuard: ToolCtx['pathGuard'],
): Promise<string> {
  try {
    const validSource = await pathGuard.validateExistingPath(source);
    return validSource;
  } catch (error) {
    if (error instanceof FsError) throw error;
    throw new FsError(ErrorCode.ACCESS_DENIED, `Move failed for ${source}`, source);
  }
}

async function performRenameWithFallback(
  validSource: string,
  validDest: string,
  fsOps: Pick<ToolFsOps, 'rename' | 'cp' | 'rm'>,
  originalSource: string,
): Promise<void> {
  try {
    await fsOps.rename(validSource, validDest);
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw error;
    }

    if (!isNodeError(error) || error.code !== 'EXDEV') {
      throw new FsError(ErrorCode.UNKNOWN, `Move failed for ${originalSource}`, originalSource);
    }

    try {
      await fsOps.cp(validSource, validDest, { recursive: true });
      await fsOps.rm(validSource, { recursive: true, force: true });
    } catch (copyOrRemoveError) {
      if (isAbortError(copyOrRemoveError)) {
        throw copyOrRemoveError;
      }
      throw new FsError(
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
  progress: (args) => {
    if (args.moves.length === 1) {
      const move = args.moves[0];
      return {
        label: 'Move',
        subject: `${basename(move?.source ?? '')} → ${basename(move?.destination ?? '')}`,
      };
    }
    return { label: 'Move', subject: `${String(args.moves.length)} files` };
  },
  defaultErrorCode: ErrorCode.UNKNOWN,
  run: async (args, ctx) => {
    const results: MoveItemResult[] = [];
    const failures: MoveFailureItem[] = [];

    for (const move of args.moves) {
      try {
        const validSource = await validateMoveSource(move.source, ctx.pathGuard);
        const validDest = await ctx.pathGuard.validatePathForWrite(move.destination);

        if (resolve(validSource) === resolve(validDest)) {
          continue;
        }

        if (resolve(validDest).startsWith(resolve(validSource) + sep)) {
          throw new FsError(
            ErrorCode.INVALID_INPUT,
            'Cannot move a directory into its own subdirectory',
            move.source,
          );
        }

        await withAbort(ctx.fs.mkdir(dirname(validDest), { recursive: true }), ctx.signal);
        await tryElicitOverwriteConfirmation(move.destination, validDest, ctx);
        await performRenameWithFallback(validSource, validDest, ctx.fs, move.source);

        results.push({ ok: true as const, from: validSource, to: validDest });
        ctx.log?.('info', `move: ${move.source} -> ${move.destination}`, 'move');
      } catch (err) {
        // Re-throw cancellation (user-declined overwrite or abort signal)
        if (isAbortError(err)) throw err;
        // Collect all other errors as per-move failures
        const structured = Problem.fromUnknown(err, ErrorCode.UNKNOWN, move.source);
        failures.push({
          source: move.source,
          destination: move.destination,
          error: structured,
        });
      }
    }

    const output: z.infer<typeof MoveOutputSchema> = {
      ok: true as const,
      moves: results,
      ...(failures.length > 0 ? { failures } : {}),
    };
    return { structured: output, text: buildSummary(results, failures) };
  },
});
