import type { PrimitiveSchemaDefinition } from '@modelcontextprotocol/server';

import { basename, dirname, resolve, sep } from 'node:path';

import * as z from 'zod/v4';

import { withAbort } from '../core/concurrency.js';
import {
  ErrorCode,
  FsError,
  isAbortError,
  isFsError,
  isNodeError,
  Problem,
} from '../core/errors.js';
import type { GuardedFileSystem } from '../core/fs.js';
import { Logger } from '../core/observability.js';
import { isSamePath } from '../core/path.js';
import { PerFileErrorSchema, RequiredPath } from '../schema.js';
import type { ToolCtx } from './define.js';
import { defineTool, isElicitationUnavailable } from './define.js';

const MoveItemSchema = z.strictObject({
  source: RequiredPath.describe('Absolute path of the file or directory to move'),
  destination: RequiredPath.describe(
    'Absolute destination path; parent directories are created automatically',
  ),
});

const MoveItemResultSchema = z.strictObject({
  from: z.string().describe('Resolved absolute source path'),
  to: z.string().describe('Resolved absolute destination path'),
  ok: z
    .literal(true)
    .describe('Always true for this entry; failures are in the outer failures array'),
});

const MoveInputSchema = z.strictObject({
  moves: z
    .array(MoveItemSchema)
    .min(1)
    .max(100)
    .describe('List of move operations to perform (max 100); each requires source and destination'),
});

const MoveFailureItemSchema = z.strictObject({
  source: z.string().describe('The source path that could not be moved'),
  destination: z.string().describe('The intended destination path for the failed move'),
  error: PerFileErrorSchema,
});

type MoveFailureItem = z.infer<typeof MoveFailureItemSchema>;

const MoveOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Always true; per-move errors are in failures[]'),
  moves: z.array(MoveItemResultSchema).describe('Successfully completed move operations'),
  failures: z
    .array(MoveFailureItemSchema)
    .optional()
    .describe('Move operations that failed with per-item error details'),
});

type MoveItemResult = z.infer<typeof MoveItemResultSchema>;

async function tryElicitOverwriteConfirmation(
  destination: string,
  validDest: string,
  ctx: Pick<ToolCtx, 'fs' | 'elicitInput'>,
): Promise<boolean> {
  if (!ctx.elicitInput) return false;

  let destExists = false;
  try {
    await ctx.fs.stat(validDest);
    destExists = true;
  } catch {
    // Destination does not exist - no confirmation needed.
  }

  if (!destExists) return false;

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
        destination,
      );
    }
    return true;
  } catch (err) {
    if (isFsError(err)) throw err;
    if (isElicitationUnavailable(err)) {
      // Connection cannot be asked at all - proceed without confirming.
      return false;
    } else {
      // Transport or unexpected failure - fail closed, don't move.
      throw new FsError(
        ErrorCode.CANCELLED,
        `Move cancelled: could not confirm overwrite of "${destination}".`,
        destination,
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

interface MoveSource {
  /** Symlink preserved — the path actually handed to rename/cp/rm. */
  renamePath: string;
  /** Symlink resolved — the identity used for every same-target comparison. */
  realPath: string;
}

/**
 * A move needs two views of its source. Renaming must operate on the link
 * itself, or moving a symlink would rename the file it points at and leave the
 * link dangling. Every collision check must instead compare the resolved
 * target, or a link moved onto itself (or onto its own target) reads as a real
 * move and renames the link over that target, destroying it.
 */
async function validateMoveSource(
  source: string,
  pathGuard: ToolCtx['pathGuard'],
): Promise<MoveSource> {
  try {
    const realPath = await pathGuard.validateExistingPath(source);
    const renamePath = await pathGuard.validatePathForDelete(source);
    return { renamePath, realPath };
  } catch (error) {
    if (isFsError(error)) throw error;
    throw new FsError(ErrorCode.ACCESS_DENIED, `Move failed for ${source}`, source);
  }
}

async function performRenameWithFallback(
  validSource: string,
  validDest: string,
  fsOps: Pick<GuardedFileSystem, 'rename' | 'cp' | 'rm'>,
  originalSource: string,
): Promise<void> {
  try {
    await fsOps.rename(validSource, validDest);
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw error;
    }

    if (!isNodeError(error) || error.code !== 'EXDEV') {
      // Preserve the original error code/message via cause so EPERM/EACCES/ENOSPC
      // surface instead of a generic UNKNOWN.
      throw new FsError(
        ErrorCode.UNKNOWN,
        `Move failed for ${originalSource}`,
        originalSource,
        undefined,
        error,
      );
    }

    // EXDEV: cross-device rename. Copy then remove, preserving symlinks and
    // timestamps so link semantics survive the move.
    let copied = false;
    try {
      await fsOps.cp(validSource, validDest, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      });
      copied = true;
      await fsOps.rm(validSource, { recursive: true, force: true });
    } catch (copyOrRemoveError) {
      if (isAbortError(copyOrRemoveError)) {
        throw copyOrRemoveError;
      }
      if (copied) {
        // cp succeeded but rm failed: the destination already holds a complete
        // copy and the source remains. Surface the rm error as the cause so the
        // caller can recover (clean up the duplicate) instead of a silent generic
        // failure that hides the partial completion.
        throw new FsError(
          ErrorCode.UNKNOWN,
          `Cross-device move of ${originalSource}: copy succeeded but source removal failed (destination holds a copy)`,
          originalSource,
          undefined,
          copyOrRemoveError,
        );
      }
      throw new FsError(
        ErrorCode.UNKNOWN,
        `Cross-device move failed for ${originalSource}`,
        originalSource,
        undefined,
        copyOrRemoveError,
      );
    }
  }
}

export const MOVE = defineTool({
  name: 'move',
  title: 'Move Files',
  description:
    'Move or rename files and directories to explicit destination paths (max 100 operations per call). ' +
    'Parent directories are created automatically. Self-moves are silently skipped.',
  input: MoveInputSchema,
  output: MoveOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  gotchas: [
    'If the destination already exists, the user is prompted to confirm overwrite when the client supports elicitation.',
    'If the client does not support elicitation, existing destinations are silently overwritten.',
    'Self-moves (source == destination) are silently skipped without error.',
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
        const { renamePath, realPath } = await validateMoveSource(move.source, ctx.pathGuard);
        const validDest = await ctx.pathGuard.validatePathForWrite(move.destination);

        // Comparisons run on the resolved source; only the fs call below uses
        // renamePath. validatePathForWrite resolves the destination through a
        // symlink too, so both sides of every check must be resolved to match.
        const resolvedSource = resolve(realPath);
        const resolvedDest = resolve(validDest);

        if (resolvedSource === resolvedDest) {
          continue;
        }

        const platform = process.platform;
        const normalizedDest =
          platform === 'win32' || platform === 'darwin' ? resolvedDest.toLowerCase() : resolvedDest;
        const normalizedSource =
          platform === 'win32' || platform === 'darwin'
            ? (resolvedSource + sep).toLowerCase()
            : resolvedSource + sep;

        if (normalizedDest.startsWith(normalizedSource)) {
          throw new FsError(
            ErrorCode.INVALID_INPUT,
            'Cannot move a directory into its own subdirectory',
            move.source,
          );
        }

        const isCaseOnlyRename = isSamePath(resolvedSource, resolvedDest);
        let destExistedOriginally = false;

        if (!isCaseOnlyRename) {
          try {
            await ctx.fs.stat(validDest);
            destExistedOriginally = true;
          } catch (err) {
            if (isNodeError(err) && err.code !== 'ENOENT') {
              Logger.warn(`move: dest stat failed unexpectedly for "${validDest}": ${String(err)}`);
            }
          }
        }

        await withAbort(ctx.fs.mkdir(dirname(validDest), { recursive: true }), ctx.signal);

        if (!isCaseOnlyRename) {
          await tryElicitOverwriteConfirmation(move.destination, validDest, ctx);
        }

        // TOCTOU check immediately before actual renaming/moving
        let existsNow = false;
        if (!isCaseOnlyRename) {
          try {
            await ctx.fs.stat(validDest);
            existsNow = true;
          } catch (err) {
            if (isNodeError(err) && err.code !== 'ENOENT') {
              Logger.warn(`move: dest stat failed unexpectedly for "${validDest}": ${String(err)}`);
            }
          }
        }

        if (existsNow && !destExistedOriginally) {
          throw new FsError(
            ErrorCode.CANCELLED,
            `Move cancelled: destination "${move.destination}" was created during confirmation.`,
            move.destination,
          );
        }

        await performRenameWithFallback(renamePath, validDest, ctx.fs, move.source);

        results.push({ ok: true as const, from: renamePath, to: validDest });
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
