import type { PrimitiveSchemaDefinition } from '@modelcontextprotocol/server';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/server';

import { basename, dirname, resolve, sep } from 'node:path';

import * as z from 'zod/v4';

import { withAbort } from '../core/concurrency.js';
import { ErrorCode, FsError, isAbortError, isNodeError, Problem } from '../core/errors.js';
import type { GuardedFileSystem } from '../core/fs.js';
import { Logger } from '../core/observability.js';
import { isSamePath } from '../core/path.js';
import { PerFileErrorSchema, RequiredPath } from '../schema.js';
import { defineTool, type ToolCtx } from './define.js';

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
        Problem.cancelled(
          `Move cancelled: "${destination}" already exists and overwrite was declined.`,
          { path: destination },
        ),
      );
    }
    return true;
  } catch (err) {
    if (err instanceof FsError) throw err;
    if (err instanceof SdkError && err.code === SdkErrorCode.CapabilityNotSupported) {
      // Client doesn't support elicitation - proceed without asking.
      return false;
    } else {
      // Transport or unexpected failure - fail closed, don't move.
      throw new FsError(
        Problem.cancelled(`Move cancelled: could not confirm overwrite of "${destination}".`, {
          path: destination,
        }),
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
    throw new FsError(Problem.accessDenied(`Move failed for ${source}`, { path: source }));
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
      throw new FsError(
        Problem.unknown(`Move failed for ${originalSource}`, { path: originalSource }),
      );
    }

    try {
      await fsOps.cp(validSource, validDest, { recursive: true });
      await fsOps.rm(validSource, { recursive: true, force: true });
    } catch (copyOrRemoveError) {
      if (isAbortError(copyOrRemoveError)) {
        throw copyOrRemoveError;
      }
      throw new FsError(
        Problem.unknown(`Cross-device move failed for ${originalSource}`, { path: originalSource }),
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
        const validSource = await validateMoveSource(move.source, ctx.pathGuard);
        const validDest = await ctx.pathGuard.validatePathForWrite(move.destination);

        const resolvedSource = resolve(validSource);
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
            Problem.invalidInput('Cannot move a directory into its own subdirectory', {
              path: move.source,
            }),
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
            Problem.cancelled(
              `Move cancelled: destination "${move.destination}" was created during confirmation.`,
              { path: move.destination },
            ),
          );
        }

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
