import type { Stats } from 'node:fs';
import { readlink, stat } from 'node:fs/promises';
import { parse } from 'node:path';

import { z } from 'zod/v4';

import { RequiredPath } from '../schemas/fields.js';
import { FileInfoSchema } from '../schemas/shared.js';

import type { FileInfo } from '../config.js';
import { assertNotAborted, withAbort } from '../core/concurrency.js';
import { ErrorCode, isAbortError } from '../core/errors.js';
import { getFileType, isHidden } from '../core/fs.js';
import type { PathGuard } from '../core/path.js';
import { DEFAULT_SEARCH_TIMEOUT_MS, getMimeType } from '../core/util.js';
import { defineTool } from './define.js';
import { buildFileInfoPayload } from './shared.js';

const StatInputSchema = z.strictObject({
  path: RequiredPath,
});

const StatOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  file: FileInfoSchema.describe('File info'),
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

export const GET_FILE_INFO = defineTool({
  name: 'stat',
  title: 'Get File Info',
  description:
    'Get file/directory metadata: size, modified, permissions, mime, tokenEstimate. ' +
    'Use `tokenEstimate` (size\u00f74) to pre-screen token cost before reading.',
  input: StatInputSchema,
  output: StatOutputSchema,
  annotations: 'readOnly',
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  run: async (args, ctx) => {
    const info = await getFileInfo(args.path, {
      includeMimeType: true,
      pathGuard: ctx.pathGuard,
      signal: ctx.signal,
    });
    return { ok: true as const, file: buildFileInfoPayload(info) };
  },
  progressLabel: (args) => `Get File Info: ${args.path}`,
  defaultErrorCode: ErrorCode.NOT_FOUND,
});
