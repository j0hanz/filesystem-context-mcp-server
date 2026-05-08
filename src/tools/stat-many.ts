import type { Stats } from 'node:fs';
import { readlink, stat } from 'node:fs/promises';
import { parse } from 'node:path';

import type { z } from 'zod/v4';

import { assertNotAborted, withAbort } from '../lib/abort.js';
import {
  DEFAULT_SEARCH_TIMEOUT_MS,
  getMimeType,
  PARALLEL_CONCURRENCY,
} from '../lib/constants.js';
import { ErrorCode, isAbortError } from '../lib/errors.js';
import {
  applyIndexedErrors,
  applyIndexedValues,
  getFileType,
  isHidden,
} from '../lib/fs-walk.js';
import { processInParallel } from '../lib/parallel.js';
import {
  assertAllowedFileAccess,
  validateExistingPathDetailed,
} from '../lib/paths.js';
import { StatManyInputSchema } from '../schemas/inputs.js';
import { StatManyOutputSchema } from '../schemas/outputs.js';

import {
  type FileInfo,
  formatBytes,
  type GetMultipleFileInfoResult,
  joinLines,
  type MultipleFileInfoResult,
} from '../config.js';
import { defineTool } from './define-tool.js';
import { FILE_READ_ICONS } from './icons.js';
import {
  buildBatchPathContext,
  buildFileInfoPayload,
  buildStructuredError,
  buildToolResponse,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolContract,
} from './shared.js';
import {
  completeProgressSession,
  createBatchProgressCallbacks,
  resolveFinalProgressCurrent,
} from './tool-execution.js';

const GET_MULTIPLE_FILE_INFO_TOOL: ToolContract = {
  name: 'stat_many',
  title: 'Get Multiple File Info',
  description:
    'Get metadata for multiple files/directories in one request. ' +
    'Use `tokenEstimate` (size\u00f74) to pre-screen token cost before reading.',
  inputSchema: StatManyInputSchema,
  outputSchema: StatManyOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: FILE_READ_ICONS,
  taskSupport: 'optional',
  defaultTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
} as const;

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
  symlinkTarget: string | undefined
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
  signal?: AbortSignal
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
}

async function getFileInfo(
  filePath: string,
  options: FileInfoOptions = {}
): Promise<FileInfo> {
  const { signal } = options;
  assertNotAborted(signal);

  const { requestedPath, resolvedPath, isSymlink } =
    await validateExistingPathDetailed(filePath, signal);

  assertAllowedFileAccess(requestedPath, resolvedPath);

  const { base: name, ext: rawExt } = parse(requestedPath);
  const ext = rawExt.toLowerCase();
  const includeMimeType = options.includeMimeType !== false;
  const mimeType =
    includeMimeType && ext.length > 0 ? getMimeType(ext) : undefined;

  const symlinkTarget = isSymlink
    ? await getSymlinkTarget(requestedPath, signal)
    : undefined;

  const stats = await withAbort(stat(resolvedPath), signal);

  return buildFileInfoResult(
    name,
    requestedPath,
    isSymlink,
    stats,
    mimeType,
    symlinkTarget
  );
}

function buildEmptyResult(): GetMultipleFileInfoResult {
  return {
    results: [],
    summary: { total: 0, succeeded: 0, failed: 0, totalSize: 0 },
  };
}

function buildIndexedPathTasks(
  paths: readonly string[]
): { filePath: string; index: number }[] {
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
  options: FileInfoOptions
): Promise<{
  results: { index: number; value: MultipleFileInfoResult }[];
  errors: { index: number; error: Error }[];
}> {
  return processInParallel(
    buildIndexedPathTasks(paths),
    async ({ filePath, index }) => {
      const info = await getFileInfo(filePath, options);
      options.onProgress?.();
      return { index, value: { path: filePath, info } };
    },
    PARALLEL_CONCURRENCY,
    options.signal
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
    if (result.info !== undefined) {
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
  options: FileInfoOptions = {}
): Promise<GetMultipleFileInfoResult> {
  if (paths.length === 0) return buildEmptyResult();

  const output: MultipleFileInfoResult[] = Array.from(paths, (p) => ({
    path: p,
  }));
  const { results, errors } = await readFileInfoInParallel(paths, options);

  applyIndexedValues(output, results);
  applyIndexedErrors({
    output,
    errors,
    resolveIndex: (failureIndex) =>
      failureIndex >= 0 && failureIndex < output.length
        ? failureIndex
        : undefined,
    buildValue: (resolvedIndex, error) => ({
      path: paths[resolvedIndex] ?? UNKNOWN_PATH,
      error,
    }),
  });

  return {
    results: output,
    summary: calculateSummary(output),
  };
}

function formatFileInfoDetail(info: FileInfo): string {
  const lines = [
    `${info.name} (${info.type})`,
    `  Path: ${info.path}`,
    `  Size: ${formatBytes(info.size)}`,
    `  Modified: ${info.modified.toISOString()}`,
  ];
  if (info.mimeType) lines.push(`  Type: ${info.mimeType}`);
  if (info.symlinkTarget) lines.push(`  Target: ${info.symlinkTarget}`);
  return joinLines(lines);
}

async function handleGetMultipleFileInfo(
  args: z.infer<typeof StatManyInputSchema>,
  signal?: AbortSignal,
  onProgress?: () => void
): Promise<{ text: string; structured: z.infer<typeof StatManyOutputSchema> }> {
  const result = await getMultipleFileInfo(args.paths, {
    includeMimeType: true,
    ...(signal !== undefined ? { signal } : {}),
    ...(onProgress !== undefined ? { onProgress } : {}),
  });

  const structuredResults: z.infer<typeof StatManyOutputSchema>['results'] =
    result.results.map((entry) => ({
      path: entry.path,
      info: entry.info ? buildFileInfoPayload(entry.info) : undefined,
      error: entry.error
        ? buildStructuredError(entry.error, ErrorCode.NOT_FOUND, entry.path)
        : undefined,
    }));

  const text = result.results
    .map((entry) => {
      if (entry.error) {
        return `${entry.path}: ${buildStructuredError(entry.error, ErrorCode.NOT_FOUND, entry.path).message}`;
      }
      if (entry.info) {
        return formatFileInfoDetail(entry.info);
      }
      return entry.path;
    })
    .join('\n\n');

  const structured: z.infer<typeof StatManyOutputSchema> = {
    ok: true,
    results: structuredResults,
    summary: {
      total: result.summary.total,
      succeeded: result.summary.succeeded,
      failed: result.summary.failed,
    },
  };

  return { text, structured };
}

export const GET_MULTIPLE_FILE_INFO = defineTool<
  z.infer<typeof StatManyInputSchema>,
  z.infer<typeof StatManyOutputSchema>
>({
  contract: GET_MULTIPLE_FILE_INFO_TOOL,
  run: async (args, ctx) => {
    const context = buildBatchPathContext(args.paths);
    const label = `${GET_MULTIPLE_FILE_INFO_TOOL.title}: ${context}`;
    const { progress, onItemComplete } = createBatchProgressCallbacks(ctx, {
      toolLabel: GET_MULTIPLE_FILE_INFO_TOOL.title,
      context,
      totalItems: args.paths.length,
      itemVerb: 'done',
    });

    const result = await completeProgressSession(progress, label, async () => {
      const { text, structured } = await handleGetMultipleFileInfo(
        args,
        ctx.signal,
        onItemComplete
      );
      const total = structured.summary.total;
      const failed = structured.summary.failed;
      const suffix = failed ? `${failed} failed` : 'done';
      const finalCurrent = resolveFinalProgressCurrent(progress, total);

      return {
        value: buildToolResponse(text, structured),
        suffix,
        finalCurrent,
      };
    });

    return result;
  },
  progressMessage: () => GET_MULTIPLE_FILE_INFO_TOOL.title,
  completionMessage: (_args, result) => {
    if (result.isError)
      return `${GET_MULTIPLE_FILE_INFO_TOOL.title} • ${result.errorCode}`;
    const sc = result.structuredContent;
    const total = sc.summary.total;
    const failed = sc.summary.failed;
    const suffix = failed ? ` • ${failed} failed` : '';
    return `${GET_MULTIPLE_FILE_INFO_TOOL.title} • ${total} ${total === 1 ? 'file' : 'files'}${suffix}`;
  },
  defaultErrorCode: ErrorCode.NOT_FOUND,
});
