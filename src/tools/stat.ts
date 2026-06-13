import type { ContentBlock } from '@modelcontextprotocol/server';

import { parse } from 'node:path';

import * as z from 'zod/v4';

import { assertNotAborted } from '../core/concurrency.js';
import { ErrorCode, isAbortError } from '../core/errors.js';
import {
  detectMimeType,
  type FileInfo,
  stat as fsStat,
  getFileType,
  isHidden,
  readlink,
  type Stats,
} from '../core/fs.js';
import type { PathGuard } from '../core/path.js';
import { DEFAULT_SEARCH_TIMEOUT_MS } from '../core/util.js';
import {
  FileInfoSchema,
  NonNegInt,
  OperationSummarySchema,
  PerFileErrorSchema,
  singleOrBatchPathsInput,
} from '../schema.js';
import { buildFileInfoPayload, formatBytes, putResource } from './_helpers.js';
import { defineTool, type PerPathResult, runOverPaths } from './define.js';

const StatInputSchema = singleOrBatchPathsInput({
  extra: {},
});

const StatPerPathSchema = z.strictObject({
  path: z.string().describe('Requested path'),
  value: FileInfoSchema.optional().describe('File info (success)'),
  error: PerFileErrorSchema.optional().describe('Per-path error'),
});

const StatOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  results: z
    .array(StatPerPathSchema)
    .describe('Per-path results (always present, ordered as input)'),
  summary: OperationSummarySchema.describe('Aggregate counts'),
  fileCount: NonNegInt.optional().describe('Count of regular files in results'),
  dirCount: NonNegInt.optional().describe('Count of directories in results'),
  resourceUri: z
    .string()
    .optional()
    .describe('URI to aggregated stats.json (present when resourceStore available)'),
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
  pathGuard: PathGuard,
  signal?: AbortSignal,
): Promise<string | undefined> {
  assertNotAborted(signal);
  try {
    const { linkString } = await readlink(pathToRead, pathGuard);
    return linkString;
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

  const { requestedPath, isSymlink } = await pathGuard.validateExistingPathDetailed(filePath);

  const { base: name, ext: rawExt } = parse(requestedPath);
  const includeMimeType = options.includeMimeType !== false;
  const mimeType =
    includeMimeType && rawExt.length > 0 ? detectMimeType(requestedPath).mimeType : undefined;

  const symlinkTarget = isSymlink
    ? await getSymlinkTarget(requestedPath, pathGuard, signal)
    : undefined;

  const { stats } = await fsStat(requestedPath, pathGuard, signal ? { signal } : undefined);

  return buildFileInfoResult(name, requestedPath, isSymlink, stats, mimeType, symlinkTarget);
}

function classifyTypeCounts(results: readonly PerPathResult<FileInfo>[]): {
  fileCount: number;
  dirCount: number;
} {
  let fileCount = 0;
  let dirCount = 0;
  for (const result of results) {
    if (result.value === undefined) continue;
    if (result.value.type === 'directory') dirCount += 1;
    else fileCount += 1;
  }
  return { fileCount, dirCount };
}

function toStatPerPathPayload(r: PerPathResult<FileInfo>): z.infer<typeof StatPerPathSchema> {
  return {
    path: r.path,
    ...(r.value ? { value: buildFileInfoPayload(r.value) } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
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
  execution: { taskSupport: 'forbidden' },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.NOT_FOUND,
  progress: (args) => {
    if (args.paths !== undefined) {
      return { label: 'Stat', subject: `${String(args.paths.length)} paths` };
    }
    return { label: 'Stat', subject: args.path ?? '' };
  },
  run: async (args, ctx) => {
    const batchInput = args.path !== undefined ? { path: args.path } : { paths: args.paths ?? [] };

    const batch = await runOverPaths<undefined, FileInfo>(
      batchInput,
      ctx,
      async ({ path }) =>
        getFileInfo(path, {
          includeMimeType: true,
          pathGuard: ctx.pathGuard,
          signal: ctx.signal,
        }),
      { defaultErrorCode: ErrorCode.NOT_FOUND },
    );

    const { fileCount, dirCount } = classifyTypeCounts(batch.results);
    const perPathPayload = batch.results.map(toStatPerPathPayload);

    let resourceUri: string | undefined;
    const resources: ContentBlock[] = [];
    if (ctx.resourceStore) {
      const { entry, link } = putResource({
        store: ctx.resourceStore,
        name: `${String(batch.summary.total)} path${batch.summary.total === 1 ? '' : 's'}`,
        mimeType: 'application/json',
        kind: 'text',
        content: JSON.stringify(perPathPayload, null, 2),
      });
      resourceUri = entry.uri;
      resources.push(link);
    }

    const text = perPathPayload
      .map((r) => {
        if (r.value) {
          const { name, type, size } = r.value;
          return `${name}: ${type}, ${formatBytes(size)}`;
        }
        return `${r.path}: ${r.error?.message ?? 'error'}`;
      })
      .join('\n');

    return {
      structured: {
        ok: true as const,
        results: perPathPayload,
        summary: batch.summary,
        fileCount,
        dirCount,
        ...(resourceUri ? { resourceUri } : {}),
      },
      text,
      ...(resources.length > 0 ? { resources } : {}),
    };
  },
});
