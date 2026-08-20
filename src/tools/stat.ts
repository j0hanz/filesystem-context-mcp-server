import type { ContentBlock } from '@modelcontextprotocol/server';

import { lstat as fsLstat } from 'node:fs/promises';
import { parse } from 'node:path';

import * as z from 'zod/v4';

import { withAbort } from '../core/concurrency.js';
import { ErrorCode, rethrowIfAborted } from '../core/errors.js';
import { formatBytes } from '../core/fmt.js';
import type { FileInfo, GuardedFileSystem, Stats } from '../core/fs.js';
import { getFileType, isHidden } from '../core/fs.js';
import { detectMimeType } from '../core/mime.js';
import { Logger } from '../core/observability.js';
import {
  FileInfoSchema,
  NonNegInt,
  OperationSummarySchema,
  PerFileErrorSchema,
  singleOrBatchPathsInput,
} from '../core/schema.js';
import { DEFAULT_SEARCH_TIMEOUT_MS } from '../core/util.js';
import { buildFileInfoPayload, putResource } from './_helpers.js';
import type { PerPathResult } from './batch.js';
import { runOverPaths } from './batch.js';
import { defineTool } from './define.js';

const StatInputSchema = singleOrBatchPathsInput({
  extra: {},
});

const StatPerPathSchema = z.strictObject({
  path: z.string().describe('The requested path'),
  value: FileInfoSchema.optional().describe('File metadata; present on success'),
  error: PerFileErrorSchema.optional().describe('Error details; present on failure'),
});

const StatOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Always true; per-path errors are in results[].error'),
  results: z
    .array(StatPerPathSchema)
    .describe('Per-path metadata results ordered to match the input paths'),
  summary: OperationSummarySchema.describe('Aggregate counts: total, succeeded, failed'),
  fileCount: NonNegInt.optional().describe('Number of regular files in the results'),
  dirCount: NonNegInt.optional().describe('Number of directories in the results'),
  resourceUri: z
    .string()
    .optional()
    .describe(
      'URI to aggregated stats.json in the resource store (present when resource store is available)',
    ),
});

function getPermissions(mode: number): string {
  let out = '';
  for (const shift of [6, 3, 0]) {
    const bits = (mode >> shift) & 0b111;
    out += (bits & 0b100 ? 'r' : '-') + (bits & 0b010 ? 'w' : '-') + (bits & 0b001 ? 'x' : '-');
  }
  return out;
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
  fs: GuardedFileSystem,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  try {
    const { linkString } = await fs.readlink(pathToRead);
    return linkString;
  } catch (error) {
    rethrowIfAborted(error);
    Logger.warn(`stat: readlink failed for "${pathToRead}": ${String(error)}`);
    return undefined;
  }
}

interface FileInfoOptions {
  includeMimeType?: boolean | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: () => void;
  fs: GuardedFileSystem;
}

async function getFileInfo(filePath: string, options: FileInfoOptions): Promise<FileInfo> {
  const { signal, fs } = options;
  signal?.throwIfAborted();

  const {
    requestedPath,
    isSymlink,
    stats: followedStats,
  } = await fs.statDetailed(filePath, signal ? { signal } : undefined);

  const { base: name, ext: rawExt } = parse(requestedPath);
  const includeMimeType = options.includeMimeType !== false;
  const mimeType =
    includeMimeType && rawExt.length > 0 ? detectMimeType(requestedPath).mimeType : undefined;

  // For a symlink, fsStat follows the link and reports the target's metadata.
  // Report the link's own metadata instead so size/permissions/timestamps
  // describe the link the user asked about, not its target.
  let stats = followedStats;
  if (isSymlink) {
    try {
      stats = await withAbort(fsLstat(requestedPath), signal);
    } catch (error) {
      // A cancelled request is not a "link metadata unavailable" fallback.
      rethrowIfAborted(error);
      stats = followedStats;
    }
  }

  // isSymlink above is true whenever ANY ancestor is a symlink, because it
  // compares the requested path with its fully-resolved real path. Only the
  // entry's own lstat says whether THIS path is a link, so a regular file under
  // a symlinked parent is reported as a file and no readlink is attempted.
  const isOwnSymlink = stats.isSymbolicLink();
  const symlinkTarget = isOwnSymlink
    ? await getSymlinkTarget(requestedPath, fs, signal)
    : undefined;

  return buildFileInfoResult(name, requestedPath, isOwnSymlink, stats, mimeType, symlinkTarget);
}

function classifyTypeCounts(results: readonly PerPathResult<FileInfo>[]): {
  fileCount: number;
  dirCount: number;
} {
  let fileCount = 0;
  let dirCount = 0;
  for (const result of results) {
    if ('error' in result) continue;
    if (result.value.type === 'directory') dirCount += 1;
    else fileCount += 1;
  }
  return { fileCount, dirCount };
}

function toStatPerPathPayload(r: PerPathResult<FileInfo>): z.infer<typeof StatPerPathSchema> {
  if ('error' in r) {
    return {
      path: r.path,
      error: r.error,
    };
  }
  return {
    path: r.path,
    value: buildFileInfoPayload(r.value),
  };
}

export const GET_FILE_INFO = defineTool({
  name: 'stat',
  title: 'Get File Info',
  description:
    'Get metadata for one or more files or directories: size, type, permissions, MIME type, timestamps, and tokenEstimate. ' +
    'Use tokenEstimate (size / 4) to pre-screen read cost before calling read. ' +
    'Single path: pass path. Batch mode: pass paths[].',
  input: StatInputSchema,
  output: StatOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
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
          fs: ctx.fs,
          signal: ctx.signal,
        }),
      { defaultErrorCode: ErrorCode.NOT_FOUND },
    );

    const { fileCount, dirCount } = classifyTypeCounts(batch.results);
    const perPathPayload = batch.results.map(toStatPerPathPayload);

    let resourceUri: string | undefined;
    const resources: ContentBlock[] = [];
    if (ctx.resourceStore && batch.summary.total > 1) {
      const { entry, link } = putResource({
        store: ctx.resourceStore,
        name: `${String(batch.summary.total)} paths`,
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
