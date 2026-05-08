import type {
  ElicitRequestFormParams,
  ElicitResult,
} from '@modelcontextprotocol/server';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/server';

import { lstat, rm, rmdir } from 'node:fs/promises';
import { basename } from 'node:path';

import { z } from 'zod/v4';

import { withAbort } from '../lib/abort.js';
import { ErrorCode, isNodeError, McpError } from '../lib/errors.js';
import { Logger } from '../lib/logger.js';
import type { PathGuard } from '../lib/path-guard.js';
import { FileType as FileTypeEnum, RequiredPath } from '../schemas/fields.js';
import {
  defaultFalseBoolean,
  OperationSummarySchema,
  PerFileErrorSchema,
} from '../schemas/shared.js';

import { defineTool } from './define-tool.js';
import { FILE_DELETE_ICONS } from './icons.js';
import {
  buildStructuredError,
  buildToolResponse,
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  type ToolContract,
  type ToolResult,
} from './shared.js';

const DeleteInputSchema = z.strictObject({
  paths: z.array(RequiredPath).min(1).describe('One or more paths to delete'),
  recursive: defaultFalseBoolean('Delete directories recursively'),
  ignoreIfNotExists: defaultFalseBoolean('No error if path does not exist'),
});

const DeleteOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  deleted: z
    .array(
      z.strictObject({
        path: z.string().describe('Deleted path'),
        type: FileTypeEnum.optional().describe('Deleted item type'),
      })
    )
    .describe('Successfully deleted items'),
  summary: OperationSummarySchema.describe('Operation summary'),
  failures: z
    .array(
      z.strictObject({
        path: z.string(),
        error: PerFileErrorSchema,
      })
    )
    .optional()
    .describe('Per-path failures'),
});

const DELETE_FILE_TOOL: ToolContract = {
  name: 'rm',
  title: 'Delete File',
  description:
    'Permanently delete one or more files or directories. This action is irreversible.',
  inputSchema: DeleteInputSchema,
  outputSchema: DeleteOutputSchema,
  annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  icons: FILE_DELETE_ICONS,
  gotchas: ['Non-empty directories require `recursive=true`.'],
  taskSupport: 'forbidden',
} as const;

type DeleteInput = z.infer<typeof DeleteInputSchema>;
type DeleteOutput = z.infer<typeof DeleteOutputSchema>;
type DeleteFailure = NonNullable<DeleteOutput['failures']>[number];
type DeletedItem = DeleteOutput['deleted'][number];

function toDeleteFailure(path: string, error: unknown): DeleteFailure {
  if (isNodeError(error)) {
    if (error.code === 'ENOENT') {
      return {
        path,
        error: buildStructuredError(error, ErrorCode.NOT_FOUND, path),
      };
    }
    if (
      error.code === 'ENOTEMPTY' ||
      error.code === 'EISDIR' ||
      error.code === 'EEXIST'
    ) {
      return {
        path,
        error: buildStructuredError(
          new Error('Directory not empty. Set recursive: true.'),
          ErrorCode.INVALID_INPUT,
          path
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
  itemStats: Awaited<ReturnType<typeof lstat>>
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
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>
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

    return (
      elicitResult.action === 'accept' && elicitResult.content?.confirm === true
    );
  } catch (err) {
    if (
      err instanceof SdkError &&
      err.code === SdkErrorCode.CapabilityNotSupported
    ) {
      return true; // Proceed if client doesn't support elicitation
    }
    return false; // Fail closed for unknown transport errors
  }
}

async function performDeletion(
  validPath: string,
  args: Pick<DeleteInput, 'recursive' | 'ignoreIfNotExists'>,
  isDirectory: boolean,
  signal?: AbortSignal
): Promise<void> {
  if (isDirectory && !args.recursive) {
    await withAbort(rmdir(validPath), signal);
  } else {
    await withAbort(
      rm(validPath, {
        recursive: args.recursive,
        force: args.ignoreIfNotExists,
      }),
      signal
    );
  }
}

async function deleteSinglePath(
  inputPath: string,
  args: Pick<DeleteInput, 'recursive' | 'ignoreIfNotExists'>,
  pathGuard: PathGuard,
  signal?: AbortSignal,
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>
): Promise<{ item: DeletedItem } | { failure: DeleteFailure }> {
  let validPath: string;
  try {
    validPath = await pathGuard.validatePathForWrite(inputPath);
  } catch (error) {
    return { failure: toDeleteFailure(inputPath, error) };
  }

  if (pathGuard.isAllowedRoot(validPath)) {
    return {
      failure: {
        path: validPath,
        error: buildStructuredError(
          new McpError(
            ErrorCode.ACCESS_DENIED,
            'Deleting a workspace root directory is not allowed'
          ),
          ErrorCode.ACCESS_DENIED,
          validPath
        ),
      },
    };
  }

  let itemStats: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    itemStats = await withAbort(lstat(validPath), signal);
  } catch (error) {
    if (
      isNodeError(error) &&
      error.code === 'ENOENT' &&
      args.ignoreIfNotExists
    ) {
      return { item: { path: validPath } };
    }
    return { failure: toDeleteFailure(inputPath, error) };
  }

  const itemType = resolveItemType(itemStats);
  const shouldProceed = await tryElicitConfirmation(
    inputPath,
    args,
    itemStats,
    elicitInput
  );

  if (!shouldProceed) {
    // User declined or transport failed — skip without deleting.
    return { item: { path: validPath, type: itemType } };
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
  elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>
): Promise<DeleteOutput> {
  const deleted: DeletedItem[] = [];
  const failures: DeleteFailure[] = [];

  for (const inputPath of args.paths) {
    const result = await deleteSinglePath(
      inputPath,
      args,
      pathGuard,
      signal,
      elicitInput
    );
    if ('item' in result) {
      deleted.push(result.item);
    } else {
      failures.push(result.failure);
    }
  }

  return {
    ok: true,
    deleted,
    summary: {
      total: args.paths.length,
      succeeded: deleted.length,
      failed: failures.length,
    },
    ...(failures.length > 0 ? { failures } : {}),
  };
}

function formatDeleteMessage(deleted: number, failed: number): string {
  if (failed > 0 && deleted === 0)
    return `Failed to delete ${failed} item${failed === 1 ? '' : 's'}`;
  if (failed > 0)
    return `Deleted ${deleted} item${deleted === 1 ? '' : 's'}; ${failed} failed`;
  return `Successfully deleted ${deleted} item${deleted === 1 ? '' : 's'}`;
}

export const DELETE_FILE = defineTool<DeleteInput, DeleteOutput>({
  contract: DELETE_FILE_TOOL,
  defaultErrorCode: ErrorCode.UNKNOWN,
  diagnosticsContext: (args) => ({ path: args.paths[0] ?? '' }),
  progressMessage: (args) => {
    const names = args.paths.map((p) => basename(p)).join(', ');
    return `${DELETE_FILE_TOOL.title}: ${names}`;
  },
  completionMessage: (args, result: ToolResult<DeleteOutput>) => {
    const names = args.paths.map((p) => basename(p)).join(', ');
    if (result.isError)
      return `${DELETE_FILE_TOOL.title}: ${names} \u2022 ${result.errorCode}`;
    const { summary } = result.structuredContent;
    return `${DELETE_FILE_TOOL.title}: ${names} \u2022 ${summary.succeeded}/${summary.total} deleted`;
  },
  run: async (args, ctx) => {
    const structured = await handleDelete(
      args,
      ctx.pathGuard,
      ctx.signal,
      ctx.elicitInput
    );
    const text = formatDeleteMessage(
      structured.summary.succeeded,
      structured.summary.failed
    );
    void ctx.log?.('info', `rm: ${args.paths.join(', ')}`, 'rm');
    return buildToolResponse(text, structured);
  },
});
