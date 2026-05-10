import type { Stats } from 'node:fs';
import { readlink, stat } from 'node:fs/promises';
import { parse } from 'node:path';

import { z } from 'zod/v4';

import type { FileInfo, GetMultipleFileInfoResult, MultipleFileInfoResult } from '../config.js';
import { assertNotAborted, processInParallel, withAbort } from '../core/concurrency.js';
import { ErrorCode, isAbortError } from '../core/errors.js';
import { getFileType, isHidden } from '../core/fs.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { DEFAULT_SEARCH_TIMEOUT_MS, getMimeType, PARALLEL_CONCURRENCY } from '../core/util.js';
import {
  FileInfoSchema,
  NonNegInt,
  OperationSummarySchema,
  PerFileErrorSchema,
  RequiredPath,
} from '../schema.js';
import {
  buildFileInfoPayload,
  buildResourceResponse,
  buildStructuredError,
  buildToolResponse,
  formatBytes,
  putResource,
} from './_helpers.js';
import { defineTool } from './define.js';

const StatInputSchema = z
  .strictObject({
    path: RequiredPath.optional().describe('Path to stat (single-path mode)'),
    paths: z
      .array(RequiredPath)
      .min(1)
      .optional()
      .describe('Paths to stat (batch mode; mutually exclusive with path)'),
  })
  .superRefine((value, ctx) => {
    if (!value.path && !value.paths) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: "Either 'path' or 'paths' is required",
        input: value,
      });
    }
    if (value.path && value.paths) {
      ctx.addIssue({
        code: 'custom',
        path: ['paths'],
        message: "Cannot use both 'path' and 'paths'",
        input: value,
      });
    }
  });

const StatManyResultItemSchema = z.strictObject({
  path: z.string().describe('Requested path'),
  info: FileInfoSchema.optional().describe('File info (when successful)'),
  error: PerFileErrorSchema.optional().describe('Error (when failed)'),
});

const StatOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  file: FileInfoSchema.optional().describe('File info (single-path mode)'),
  // Batch mode fields
  results: z.array(StatManyResultItemSchema).optional().describe('Per-path results (batch mode)'),
  summary: OperationSummarySchema.optional().describe('Operation summary (batch mode)'),
  fileCount: NonNegInt.optional().describe('Number of files (batch mode)'),
  dirCount: NonNegInt.optional().describe('Number of directories (batch mode)'),
  resourceUri: z.string().optional().describe('URI to stats.json resource (batch mode)'),
});

const PERM_STRINGS = [
  '---',
  '--x',
  '-w-',
  '-wx',
  'r--',
  'r-x',
  'rw-',
  'rwx',
] as const satisfies readonly string[];

function getPermissions(mode: number): string {
  return (
    (PERM_STRINGS[(mode >> 6) & 0b111] ?? '---') +
    (PERM_STRINGS[(mode >> 3) & 0b111] ?? '---') +
    (PERM_STRINGS[mode & 0b111] ?? '---')
  );
}

function buildFileInfoResult(
  name: string,
  requestedPath: string,
  isSymlink: boolean,
  stats: Stats,
  mimeType: string | undefined,
  symlinkTarget: string | undefined,
): FileInfo {
  const tokenEstimate = stats.isFile() ? Math.ceil(stats.size / 4) : undefined;
  return {
    name,
    path: requestedPath,
    type: isSymlink ? 'symlink' : getFileType(stats),
    size: stats.size,
    ...(tokenEstimate !== undefined ? { tokenEstimate } : {}),
    created: stats.birthtime,
    modified: stats.mtime,
    accessed: stats.atime,
    permissions: getPermissions(stats.mode),
    isHidden: isHidden(name),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(symlinkTarget !== undefined ? { symlinkTarget } : {}),
  };
}

async function getSymlinkTarget(
  pathToRead: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  assertNotAborted(signal);
  try {
    return await withAbort(readlink(pathToRead), signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

interface FileInfoOptions {
  includeMimeType?: boolean | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: () => void;
  pathGuard: PathGuard;
}

async function getFileInfo(filePath: string, options: FileInfoOptions): Promise<FileInfo> {
  const { signal, pathGuard } = options;
  assertNotAborted(signal);

  const { requestedPath, resolvedPath, isSymlink } =
    await pathGuard.validateExistingPathDetailed(filePath);

  pathGuard.assertAllowedFileAccess(requestedPath);

  const { base: name, ext: rawExt } = parse(requestedPath);
  const ext = rawExt.toLowerCase();
  const includeMimeType = options.includeMimeType !== false;
  const mimeType = includeMimeType && ext.length > 0 ? getMimeType(ext) : undefined;

  const symlinkTarget = isSymlink ? await getSymlinkTarget(requestedPath, signal) : undefined;

  const stats = await withAbort(stat(resolvedPath), signal);

  return buildFileInfoResult(name, requestedPath, isSymlink, stats, mimeType, symlinkTarget);
}

// ---------------------------------------------------------------------------
// Multi-path (batch) implementation
// ---------------------------------------------------------------------------

const UNKNOWN_PATH = '(unknown)';

function buildIndexedPathTasks(paths: readonly string[]): { filePath: string; index: number }[] {
  const tasks: { filePath: string; index: number }[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const filePath = paths[index];
    if (filePath !== undefined) tasks.push({ filePath, index });
  }
  return tasks;
}

async function readFileInfoInParallel(
  paths: readonly string[],
  options: FileInfoOptions,
): Promise<{
  results: { index: number; value: MultipleFileInfoResult }[];
  errors: { index: number; error: Error }[];
}> {
  return processInParallel(
    buildIndexedPathTasks(paths),
    async ({ filePath, index }) => {
      const info = await getFileInfo(filePath, options);
      options.onProgress?.();
      return { index, value: { path: filePath, status: 'success' as const, info } };
    },
    PARALLEL_CONCURRENCY,
    options.signal,
  );
}

function calculateSummary(results: readonly MultipleFileInfoResult[]): {
  total: number;
  succeeded: number;
  failed: number;
  totalSize: number;
} {
  let succeeded = 0;
  let failed = 0;
  let totalSize = 0;
  for (const result of results) {
    if (result.status === 'success') {
      succeeded++;
      totalSize += result.info.size;
    } else {
      failed++;
    }
  }
  return { total: results.length, succeeded, failed, totalSize };
}

async function getMultipleFileInfo(
  paths: readonly string[],
  options: FileInfoOptions,
): Promise<GetMultipleFileInfoResult> {
  if (paths.length === 0) {
    return { results: [], summary: { total: 0, succeeded: 0, failed: 0, totalSize: 0 } };
  }
  const output = new Array<MultipleFileInfoResult>(paths.length);
  const { results, errors } = await readFileInfoInParallel(paths, options);
  for (const { index, value } of results) output[index] = value;
  for (const { index, error } of errors) {
    if (index >= 0 && index < output.length) {
      output[index] = { path: paths[index] ?? UNKNOWN_PATH, status: 'error', error };
    }
  }
  for (let i = 0; i < output.length; i++) {
    output[i] ??= {
      path: paths[i] ?? UNKNOWN_PATH,
      status: 'error',
      error: new Error('Unknown error'),
    };
  }
  return { results: output, summary: calculateSummary(output) };
}

function countFilesAndDirs(results: readonly MultipleFileInfoResult[]): {
  fileCount: number;
  dirCount: number;
} {
  let fileCount = 0;
  let dirCount = 0;
  for (const result of results) {
    if (result.status === 'success') {
      if (result.info.type === 'directory') dirCount++;
      else fileCount++;
    }
  }
  return { fileCount, dirCount };
}

type StatOutput = z.infer<typeof StatOutputSchema>;

async function handleGetMultipleFileInfo(
  paths: string[],
  pathGuard: PathGuard,
  resourceStore: ResourceStore | undefined,
  signal?: AbortSignal,
  onProgress?: () => void,
): Promise<StatOutput | ReturnType<typeof buildResourceResponse<StatOutput>>> {
  const result = await getMultipleFileInfo(paths, {
    includeMimeType: true,
    pathGuard,
    ...(signal !== undefined ? { signal } : {}),
    ...(onProgress !== undefined ? { onProgress } : {}),
  });

  const structuredResults = result.results.map((entry) => ({
    path: entry.path,
    info: entry.status === 'success' ? buildFileInfoPayload(entry.info) : undefined,
    error:
      entry.status === 'error'
        ? buildStructuredError(entry.error, ErrorCode.NOT_FOUND, entry.path)
        : undefined,
  }));

  const { fileCount, dirCount } = countFilesAndDirs(result.results);
  const statsJson = JSON.stringify(structuredResults, null, 2);

  if (!resourceStore) throw new Error('ResourceStore is required for batch stat');
  const { entry: statsEntry, link: statsLink } = putResource({
    store: resourceStore,
    name: 'stats.json',
    mimeType: 'application/json',
    kind: 'text',
    content: statsJson,
  });

  const summary =
    fileCount === 1 && dirCount === 0
      ? 'stat: 1 file'
      : fileCount === 0 && dirCount === 1
        ? 'stat: 1 directory'
        : `stat: ${String(fileCount)} file${fileCount === 1 ? '' : 's'} \u00b7 ${String(dirCount)} director${dirCount === 1 ? 'y' : 'ies'}`;

  return buildResourceResponse({
    summary,
    resources: [statsLink],
    structured: {
      ok: true as const,
      results: structuredResults,
      summary: {
        total: result.summary.total,
        succeeded: result.summary.succeeded,
        failed: result.summary.failed,
      },
      fileCount,
      dirCount,
      resourceUri: statsEntry.uri,
    },
  });
}

export const GET_FILE_INFO = defineTool({
  name: 'stat',
  title: 'Get File Info',
  description:
    'Get file/directory metadata: size, modified, permissions, mime, tokenEstimate. ' +
    'Use `tokenEstimate` (size\u00f74) to pre-screen token cost before reading. ' +
    'Pass `paths` array for batch mode.',
  input: StatInputSchema,
  output: StatOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execution: { taskSupport: 'optional' },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.NOT_FOUND,
  progressLabel: (args) =>
    args.paths ? `Get File Info: ${args.paths.length} paths` : `Get File Info: ${args.path ?? ''}`,
  run: async (args, ctx) => {
    if (args.paths) {
      const total = args.paths.length;
      let completed = 0;
      const onProgress = (): void => {
        completed++;
        ctx.onProgress?.({ current: completed, total, message: `stat: ${completed}/${total}` });
      };
      return handleGetMultipleFileInfo(
        args.paths,
        ctx.pathGuard,
        ctx.resourceStore,
        ctx.signal,
        onProgress,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const info = await getFileInfo(args.path!, {
      includeMimeType: true,
      pathGuard: ctx.pathGuard,
      signal: ctx.signal,
    });
    const parts = [info.name, formatBytes(info.size)];
    if (info.symlinkTarget) parts.push(`\u2192 ${info.symlinkTarget}`);
    return buildToolResponse(`stat: ${parts.join(' \u2022 ')}`, {
      ok: true as const,
      file: buildFileInfoPayload(info),
    });
  },
});
