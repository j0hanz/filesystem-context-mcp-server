import type { Stats } from 'node:fs';
import { readlink, stat } from 'node:fs/promises';
import { parse } from 'node:path';

import { z } from 'zod/v4';

import { NonNegInt, RequiredPath } from '../schemas/fields.js';
import { FileInfoSchema, OperationSummarySchema, PerFileErrorSchema } from '../schemas/shared.js';

import type { FileInfo, GetMultipleFileInfoResult, MultipleFileInfoResult } from '../config.js';
import { assertNotAborted, processInParallel, withAbort } from '../core/concurrency.js';
import { ErrorCode, isAbortError } from '../core/errors.js';
import { getFileType, isHidden } from '../core/fs.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { DEFAULT_SEARCH_TIMEOUT_MS, getMimeType, PARALLEL_CONCURRENCY } from '../core/util.js';
import { defineTool } from './define.js';
import { buildFileInfoPayload, buildStructuredError, putResource } from './shared.js';

const StatManyInputSchema = z.strictObject({
  paths: z.array(RequiredPath).min(1).describe('Paths to stat'),
});

const StatManyOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('Requested path'),
        info: FileInfoSchema.optional().describe('File info (when successful)'),
        error: PerFileErrorSchema.optional().describe('Error (when failed)'),
      }),
    )
    .describe('Per-path results'),
  summary: OperationSummarySchema.describe('Operation summary'),
  fileCount: NonNegInt.describe('Number of files'),
  dirCount: NonNegInt.describe('Number of directories'),
  resourceUri: z.string().describe('URI to stats.json resource'),
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

const UNKNOWN_PATH = '(unknown)';

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

function buildEmptyResult(): GetMultipleFileInfoResult {
  return {
    results: [],
    summary: { total: 0, succeeded: 0, failed: 0, totalSize: 0 },
  };
}

function buildIndexedPathTasks(paths: readonly string[]): { filePath: string; index: number }[] {
  const tasks: { filePath: string; index: number }[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const filePath = paths[index];
    if (filePath !== undefined) {
      tasks.push({ filePath, index });
    }
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
      return { index, value: { path: filePath, status: 'success', info } };
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

  return {
    total: results.length,
    succeeded,
    failed,
    totalSize,
  };
}

async function getMultipleFileInfo(
  paths: readonly string[],
  options: FileInfoOptions,
): Promise<GetMultipleFileInfoResult> {
  if (paths.length === 0) return buildEmptyResult();

  const output = new Array<MultipleFileInfoResult>(paths.length);
  const { results, errors } = await readFileInfoInParallel(paths, options);

  for (const { index, value } of results) {
    output[index] = value;
  }
  for (const { index, error } of errors) {
    if (index >= 0 && index < output.length) {
      output[index] = {
        path: paths[index] ?? UNKNOWN_PATH,
        status: 'error',
        error,
      };
    }
  }

  // Fallback for missing entries if any
  for (let i = 0; i < output.length; i++) {
    output[i] ??= {
      path: paths[i] ?? UNKNOWN_PATH,
      status: 'error',
      error: new Error('Unknown error'),
    };
  }

  return {
    results: output,
    summary: calculateSummary(output),
  };
}

function countFilesAndDirs(results: readonly MultipleFileInfoResult[]): {
  fileCount: number;
  dirCount: number;
} {
  let fileCount = 0;
  let dirCount = 0;

  for (const result of results) {
    if (result.status === 'success') {
      if (result.info.type === 'directory') {
        dirCount++;
      } else {
        fileCount++;
      }
    }
  }

  return { fileCount, dirCount };
}

async function handleGetMultipleFileInfo(
  args: z.infer<typeof StatManyInputSchema>,
  pathGuard: PathGuard,
  resourceStore: ResourceStore | undefined,
  signal?: AbortSignal,
  onProgress?: () => void,
): Promise<z.infer<typeof StatManyOutputSchema>> {
  const result = await getMultipleFileInfo(args.paths, {
    includeMimeType: true,
    pathGuard,
    ...(signal !== undefined ? { signal } : {}),
    ...(onProgress !== undefined ? { onProgress } : {}),
  });

  const structuredResults: z.infer<typeof StatManyOutputSchema>['results'] = result.results.map(
    (entry) => ({
      path: entry.path,
      info: entry.status === 'success' ? buildFileInfoPayload(entry.info) : undefined,
      error:
        entry.status === 'error'
          ? buildStructuredError(entry.error, ErrorCode.NOT_FOUND, entry.path)
          : undefined,
    }),
  );

  const { fileCount, dirCount } = countFilesAndDirs(result.results);

  // Serialize stats to JSON for resource storage
  const statsData = result.results.map((entry) => ({
    path: entry.path,
    info: entry.status === 'success' ? buildFileInfoPayload(entry.info) : undefined,
    error:
      entry.status === 'error'
        ? buildStructuredError(entry.error, ErrorCode.NOT_FOUND, entry.path)
        : undefined,
  }));
  const statsJson = JSON.stringify(statsData, null, 2);

  // Store stats JSON as a resource
  if (!resourceStore) {
    throw new Error('ResourceStore is required for stat-many tool');
  }
  const { entry: statsEntry } = putResource({
    store: resourceStore,
    name: 'stats.json',
    mimeType: 'application/json',
    kind: 'text',
    content: statsJson,
  });

  return {
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
  };
}

export const GET_MULTIPLE_FILE_INFO = defineTool({
  name: 'stat_many',
  title: 'Get Multiple File Info',
  description:
    'Get metadata for multiple files/directories in one request. ' +
    'Use `tokenEstimate` (size\u00f74) to pre-screen token cost before reading.',
  input: StatManyInputSchema,
  output: StatManyOutputSchema,
  annotations: 'readOnly',
  task: 'optional',
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.NOT_FOUND,
  progressLabel: (args) => `Get Multiple File Info: ${args.paths.length} paths`,
  run: async (args, ctx) => {
    const total = args.paths.length;
    let completed = 0;
    const onProgress = (): void => {
      completed++;
      ctx.onProgress?.({ current: completed, total, message: `stat_many: ${completed}/${total}` });
    };
    return handleGetMultipleFileInfo(
      args,
      ctx.pathGuard,
      ctx.resourceStore,
      ctx.signal,
      onProgress,
    );
  },
});
