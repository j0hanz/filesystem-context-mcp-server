import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.js';
import { ErrorCode, isNodeError, Problem } from '../core/errors.js';
import type { GuardedFileSystem } from '../core/fs.js';
import { Logger } from '../core/observability.js';
import { defaultFalseBoolean, RequiredPath } from '../core/schema.js';
import { PARALLEL_CONCURRENCY } from '../core/util.js';
import type { ToolCtx } from './define.js';
import { confirmBoolean, defineTool } from './define.js';

const DeleteInputSchema = z.strictObject({
  paths: z
    .array(RequiredPath)
    .min(1)
    .max(1000)
    .describe('Paths to delete (max 1000); accepts files, directories, or symlinks'),
  recursive: defaultFalseBoolean(
    'Delete directories and all their contents recursively (required for non-empty directories)',
  ),
  ignoreIfNotExists: defaultFalseBoolean(
    'Silently succeed if a path does not exist instead of returning an error',
  ),
});

const DeleteFailureItemSchema = z.strictObject({
  path: z.string(),
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
  }),
});

const DeleteOutputSchema = z.strictObject({
  ok: z
    .boolean()
    .describe(
      'True only when all requested paths were deleted successfully; false if any path failed',
    ),
  path: z.string().optional().describe('Deleted path (present when exactly one path was deleted)'),
  paths: z
    .array(z.string())
    .optional()
    .describe('Deleted paths (present when multiple paths were deleted)'),
  failures: z
    .array(DeleteFailureItemSchema)
    .optional()
    .describe('Per-path error details for paths that could not be deleted'),
});

type DeleteInput = z.infer<typeof DeleteInputSchema>;
type DeleteOutput = z.infer<typeof DeleteOutputSchema>;
type DeleteFailureItem = z.infer<typeof DeleteFailureItemSchema>;

// Internal types for error handling
interface DeletedItem {
  path: string;
}
interface DeleteFailure {
  path: string;
  error: {
    code: string;
    message: string;
    path?: string;
    suggestion?: string;
  };
}

function toDeleteFailure(path: string, error: unknown): DeleteFailure {
  if (
    isNodeError(error) &&
    (error.code === 'ENOTEMPTY' || error.code === 'EISDIR' || error.code === 'EEXIST')
  ) {
    return {
      path,
      error: Problem.fromUnknown(
        new Error('Directory not empty. Set recursive: true.'),
        ErrorCode.INVALID_INPUT,
        path,
      ),
    };
  }
  return { path, error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, path) };
}

function resolveItemType(
  itemStats: Awaited<ReturnType<GuardedFileSystem['lstat']>>,
): 'directory' | 'symlink' | 'file' | 'other' {
  if (itemStats.stats.isDirectory()) return 'directory';
  if (itemStats.stats.isSymbolicLink()) return 'symlink';
  if (itemStats.stats.isFile()) return 'file';
  return 'other';
}

async function tryElicitConfirmation(
  validPath: string,
  args: Pick<DeleteInput, 'recursive'>,
  itemStats: Awaited<ReturnType<GuardedFileSystem['lstat']>>,
  fs: Pick<GuardedFileSystem, 'hasChildrenUnchecked'>,
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>,
): Promise<boolean> {
  if (!elicitInput || !args.recursive || !itemStats.stats.isDirectory()) {
    return true; // Proceed if not applicable
  }

  const nonEmpty = await fs.hasChildrenUnchecked(validPath);
  if (!nonEmpty) {
    return true; // Empty directory — nothing to recursively destroy, no prompt needed
  }

  const r = await confirmBoolean(
    { elicitInput },
    'confirm',
    `Permanently delete "${validPath}" and all its contents? This cannot be undone.`,
    'Yes, delete permanently',
  );
  if (r.unavailable) return true; // Connection cannot be asked at all — proceed unprompted.
  if (r.error) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- r.error is the unknown elicitation failure, stringified for a warning only
    Logger.warn(`delete: elicitation failed for "${validPath}": ${String(r.error)}`);
    return false; // Fail closed for unknown transport errors
  }
  return r.confirmed;
}

async function performDeletion(
  validPath: string,
  args: Pick<DeleteInput, 'recursive' | 'ignoreIfNotExists'>,
  isDirectory: boolean,
  fsOps: Pick<GuardedFileSystem, 'rm' | 'rmdir'>,
): Promise<void> {
  if (isDirectory && !args.recursive) {
    await fsOps.rmdir(validPath);
  } else {
    await fsOps.rm(validPath, {
      recursive: args.recursive,
      force: args.ignoreIfNotExists,
    });
  }
}

async function deleteSinglePath(
  inputPath: string,
  args: Pick<DeleteInput, 'recursive' | 'ignoreIfNotExists'>,
  ctx: Pick<ToolCtx, 'fs' | 'signal' | 'elicitInput'>,
): Promise<{ item: DeletedItem } | { failure: DeleteFailure }> {
  let validPath: string;
  try {
    validPath = await ctx.fs.pathGuard.validatePathForDelete(inputPath);
  } catch (error) {
    return { failure: toDeleteFailure(inputPath, error) };
  }

  if (ctx.fs.pathGuard.isAllowedRoot(validPath)) {
    return {
      failure: {
        path: validPath,
        error: Problem.accessDenied('Deleting a workspace root directory is not allowed', {
          path: validPath,
        }),
      },
    };
  }

  let itemStats: Awaited<ReturnType<GuardedFileSystem['lstat']>> | undefined;
  try {
    itemStats = await ctx.fs.lstat(validPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT' && args.ignoreIfNotExists) {
      return { item: { path: validPath } };
    }
    return { failure: toDeleteFailure(inputPath, error) };
  }

  const itemType = resolveItemType(itemStats);
  const shouldProceed = await tryElicitConfirmation(
    validPath,
    args,
    itemStats,
    ctx.fs,
    ctx.elicitInput,
  );

  if (!shouldProceed) {
    return {
      failure: {
        path: validPath,
        error: Problem.cancelled('Delete cancelled: confirmation prompt failed or was declined', {
          path: validPath,
        }),
      },
    };
  }

  // TOCTOU check: re-stat the path immediately before deletion
  let currentStats: Awaited<ReturnType<GuardedFileSystem['lstat']>>;
  try {
    currentStats = await ctx.fs.lstat(validPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT' && args.ignoreIfNotExists) {
      return { item: { path: validPath } };
    }
    return { failure: toDeleteFailure(inputPath, error) };
  }

  const currentItemType = resolveItemType(currentStats);
  // Identity comparison, not just the coarse category: a swap during the
  // elicitation gap (delete original, create a same-named replacement) keeps
  // the type but changes dev/ino/birthtimeMs. birthtimeMs is the primary
  // cross-platform signal — dev/ino can read 0 on some non-POSIX drivers — so
  // combine all three rather than trusting dev/ino alone.
  const identityChanged =
    itemStats.stats.dev !== currentStats.stats.dev ||
    itemStats.stats.ino !== currentStats.stats.ino ||
    itemStats.stats.birthtimeMs !== currentStats.stats.birthtimeMs;
  if (itemType !== 'other' && (currentItemType !== itemType || identityChanged)) {
    return {
      failure: {
        path: validPath,
        error: Problem.invalidInput(
          `Delete failed: item type changed from ${itemType} to ${currentItemType} during confirmation.`,
          { path: validPath },
        ),
      },
    };
  }

  try {
    await performDeletion(validPath, args, currentStats.stats.isDirectory(), ctx.fs);
  } catch (error) {
    return { failure: toDeleteFailure(inputPath, error) };
  }

  Logger.info(`rm: ${inputPath}`);
  return { item: { path: validPath } };
}

async function handleDelete(args: DeleteInput, ctx: ToolCtx): Promise<DeleteOutput> {
  const { results, errors } = await processInParallel(
    args.paths,
    (inputPath) => deleteSinglePath(inputPath, args, ctx),
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );

  const successPaths: string[] = [];
  const failures: DeleteFailureItem[] = [];

  for (const { value: r } of results) {
    if ('failure' in r) {
      failures.push({
        path: r.failure.path,
        error: {
          code: r.failure.error.code,
          message: r.failure.error.message,
        },
      });
    } else if (r.item.path) {
      successPaths.push(r.item.path);
    }
  }

  // Guard against unexpected throws from deleteSinglePath (should not occur in practice)
  for (const { index, error } of errors) {
    const path = args.paths[index] ?? '(unknown)';
    failures.push({
      path,
      error: { code: ErrorCode.UNKNOWN, message: error.message },
    });
  }

  const ok = failures.length === 0;
  const output: DeleteOutput = { ok };
  if (successPaths.length === 1) {
    output.path = successPaths[0];
  } else if (successPaths.length > 1) {
    output.paths = successPaths;
  }
  if (failures.length > 0) {
    output.failures = failures;
  }
  return output;
}

export const DELETE_FILE = defineTool({
  name: 'delete',
  title: 'Delete File',
  description:
    'Permanently delete one or more files, directories, or symlinks (max 1000 per call). This action is irreversible. ' +
    'Non-empty directories require recursive=true. ' +
    'Workspace root directories cannot be deleted.',
  input: DeleteInputSchema,
  output: DeleteOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  defaultErrorCode: ErrorCode.UNKNOWN,
  progress: (args) => ({
    label: 'Delete',
    subject: args.paths.map((p) => basename(p)).join(' · '),
  }),
  run: async (args, ctx) => {
    const structured = await handleDelete(args, ctx);
    const deleted = structured.paths ?? (structured.path ? [structured.path] : []);
    const failCount = structured.failures?.length ?? 0;
    const delCount = deleted.length;
    const failSuffix =
      failCount > 0 ? `, ${String(failCount)} failure${failCount === 1 ? '' : 's'}` : '';
    const summary =
      delCount > 0
        ? `delete: deleted ${delCount === 1 ? (deleted[0] ?? '') : `${String(delCount)} paths`}${failSuffix}`
        : `delete: ${String(failCount)} failure${failCount === 1 ? '' : 's'}`;
    return { structured, text: summary };
  },
});
