import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/server';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/server';

import { lstat, rm, rmdir } from 'node:fs/promises';
import { basename } from 'node:path';

import { z } from 'zod/v4';

import { processInParallel, withAbort } from '../core/concurrency.js';
import { ErrorCode, isNodeError, McpError } from '../core/errors.js';
import { Logger } from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import { PARALLEL_CONCURRENCY } from '../core/util.js';
import { defaultFalseBoolean, RequiredPath } from '../schema.js';
import { buildStructuredError, buildToolResponse } from './_helpers.js';
import { defineTool } from './define.js';

const DeleteInputSchema = z.strictObject({
  paths: z.array(RequiredPath).min(1).max(1000).describe('One or more paths to delete (max 1000)'),
  recursive: defaultFalseBoolean('Delete directories recursively'),
  ignoreIfNotExists: defaultFalseBoolean('No error if path does not exist'),
});

const DeleteFailureItemSchema = z.strictObject({
  path: z.string(),
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
  }),
});

const DeleteOutputSchema = z.strictObject({
  ok: z.boolean().describe('Success indicator — false only when every path failed'),
  path: z.string().optional().describe('Deleted path'),
  paths: z.array(z.string()).optional().describe('Deleted paths (multi-path mode)'),
  failures: z.array(DeleteFailureItemSchema).optional().describe('Per-path errors'),
});

type DeleteInput = z.infer<typeof DeleteInputSchema>;
type DeleteOutput = z.infer<typeof DeleteOutputSchema>;
type DeleteFailureItem = z.infer<typeof DeleteFailureItemSchema>;

// Internal types for error handling
interface DeletedItem {
  path: string;
  type?: 'directory' | 'symlink' | 'file' | 'other';
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
  if (isNodeError(error)) {
    if (error.code === 'ENOENT') {
      return {
        path,
        error: buildStructuredError(error, ErrorCode.NOT_FOUND, path),
      };
    }
    if (error.code === 'ENOTEMPTY' || error.code === 'EISDIR' || error.code === 'EEXIST') {
      return {
        path,
        error: buildStructuredError(
          new Error('Directory not empty. Set recursive: true.'),
          ErrorCode.INVALID_INPUT,
          path,
        ),
      };
    }
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      return {
        path,
        error: buildStructuredError(error, ErrorCode.PERMISSION_DENIED, path),
      };
    }
  }
  return { path, error: buildStructuredError(error, ErrorCode.UNKNOWN, path) };
}

function resolveItemType(
  itemStats: Awaited<ReturnType<typeof lstat>>,
): 'directory' | 'symlink' | 'file' | 'other' {
  if (itemStats.isDirectory()) return 'directory';
  if (itemStats.isSymbolicLink()) return 'symlink';
  if (itemStats.isFile()) return 'file';
  return 'other';
}

async function tryElicitConfirmation(
  inputPath: string,
  args: Pick<DeleteInput, 'recursive'>,
  itemStats: Awaited<ReturnType<typeof lstat>>,
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>,
): Promise<boolean> {
  if (!elicitInput || !args.recursive || !itemStats.isDirectory()) {
    return true; // Proceed if not applicable
  }

  try {
    const elicitResult = await elicitInput({
      mode: 'form',
      message: `Permanently delete "${inputPath}" and all its contents? This cannot be undone.`,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', title: 'Yes, delete permanently' },
        },
        required: ['confirm'],
      },
    });

    return elicitResult.action === 'accept' && elicitResult.content?.['confirm'] === true;
  } catch (err) {
    if (err instanceof SdkError && err.code === SdkErrorCode.CapabilityNotSupported) {
      return true; // Proceed if client doesn't support elicitation
    }
    return false; // Fail closed for unknown transport errors
  }
}

async function performDeletion(
  validPath: string,
  args: Pick<DeleteInput, 'recursive' | 'ignoreIfNotExists'>,
  isDirectory: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (isDirectory && !args.recursive) {
    await withAbort(rmdir(validPath), signal);
  } else {
    await withAbort(
      rm(validPath, {
        recursive: args.recursive,
        force: args.ignoreIfNotExists,
      }),
      signal,
    );
  }
}

async function deleteSinglePath(
  inputPath: string,
  args: Pick<DeleteInput, 'recursive' | 'ignoreIfNotExists'>,
  pathGuard: PathGuard,
  signal?: AbortSignal,
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>,
): Promise<{ item: DeletedItem } | { failure: DeleteFailure }> {
  let validPath: string;
  try {
    validPath = await pathGuard.validatePathForWrite(inputPath);
  } catch (error) {
    // Path guard violation: collect in failures[] instead of throwing
    return { failure: toDeleteFailure(inputPath, error) };
  }

  if (pathGuard.isAllowedRoot(validPath)) {
    return {
      failure: {
        path: validPath,
        error: buildStructuredError(
          new McpError(
            ErrorCode.ACCESS_DENIED,
            'Deleting a workspace root directory is not allowed',
          ),
          ErrorCode.ACCESS_DENIED,
          validPath,
        ),
      },
    };
  }

  let itemStats: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    itemStats = await withAbort(lstat(validPath), signal);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT' && args.ignoreIfNotExists) {
      return { item: { path: validPath } };
    }
    return { failure: toDeleteFailure(inputPath, error) };
  }

  const itemType = resolveItemType(itemStats);
  const shouldProceed = await tryElicitConfirmation(inputPath, args, itemStats, elicitInput);

  if (!shouldProceed) {
    return {
      failure: {
        path: validPath,
        error: buildStructuredError(
          new McpError(ErrorCode.CANCELLED, 'Delete cancelled by user'),
          ErrorCode.CANCELLED,
          validPath,
        ),
      },
    };
  }

  try {
    await performDeletion(validPath, args, itemStats.isDirectory(), signal);
  } catch (error) {
    return { failure: toDeleteFailure(inputPath, error) };
  }

  Logger.info(`rm: ${inputPath}`);
  return { item: { path: validPath, type: itemType } };
}

async function handleDelete(
  args: DeleteInput,
  pathGuard: PathGuard,
  signal?: AbortSignal,
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>,
): Promise<DeleteOutput> {
  const { results, errors } = await processInParallel(
    args.paths,
    (inputPath) => deleteSinglePath(inputPath, args, pathGuard, signal, elicitInput),
    PARALLEL_CONCURRENCY,
    signal,
  );

  const successPaths: string[] = [];
  const failures: DeleteFailureItem[] = [];

  for (const r of results) {
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

  const ok = successPaths.length > 0 || args.paths.length === 0;
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
  description: 'Permanently delete one or more files or directories. This action is irreversible.',
  input: DeleteInputSchema,
  output: DeleteOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  gotchas: [
    'Non-empty directories require `recursive=true`.',
    'ok: false only when every path failed. Partial failures return ok: true — always check failures[] for per-path errors.',
  ],
  defaultErrorCode: ErrorCode.UNKNOWN,
  progressLabel: (args) => `Delete File: ${args.paths.map((p) => basename(p)).join(', ')}`,
  run: async (args, ctx) => {
    const structured = await handleDelete(args, ctx.pathGuard, ctx.signal, ctx.elicitInput);
    const deleted = structured.paths ?? (structured.path ? [structured.path] : []);
    const failCount = structured.failures?.length ?? 0;
    const delCount = deleted.length;
    const failSuffix =
      failCount > 0 ? `, ${String(failCount)} failure${failCount === 1 ? '' : 's'}` : '';
    const summary =
      delCount > 0
        ? `delete-file: deleted ${delCount === 1 ? (deleted[0] ?? '') : `${String(delCount)} paths`}${failSuffix}`
        : `delete-file: ${String(failCount)} failure${failCount === 1 ? '' : 's'}`;
    return buildToolResponse(summary, structured);
  },
});
