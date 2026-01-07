import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Stats } from 'node:fs';

import type { FileInfo } from '../../config/types.js';
import { getMimeType } from '../constants.js';
import { getFileType, isHidden } from '../fs-helpers.js';
import { assertNotAborted, withAbort } from '../fs-helpers/abort.js';
import { validateExistingPathDetailed } from '../path-validation.js';

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
  const ownerIndex = (mode >> 6) & 0b111;
  const groupIndex = (mode >> 3) & 0b111;
  const otherIndex = mode & 0b111;
  const owner = PERM_STRINGS[ownerIndex] ?? '---';
  const group = PERM_STRINGS[groupIndex] ?? '---';
  const other = PERM_STRINGS[otherIndex] ?? '---';

  return `${owner}${group}${other}`;
}

function resolveMimeType(
  ext: string,
  includeMimeType: boolean
): string | undefined {
  if (!includeMimeType) return undefined;
  if (!ext) return undefined;
  return getMimeType(ext);
}

async function resolveSymlinkTarget(
  pathToRead: string,
  isSymlink: boolean,
  signal?: AbortSignal
): Promise<string | undefined> {
  if (!isSymlink) return undefined;
  return getSymlinkTarget(pathToRead, signal);
}

function buildFileInfoResult(
  name: string,
  requestedPath: string,
  isSymlink: boolean,
  stats: Stats,
  mimeType: string | undefined,
  symlinkTarget: string | undefined
): FileInfo {
  return {
    name,
    path: requestedPath,
    type: isSymlink ? 'symlink' : getFileType(stats),
    size: stats.size,
    created: stats.birthtime,
    modified: stats.mtime,
    accessed: stats.atime,
    permissions: getPermissions(stats.mode),
    isHidden: isHidden(name),
    mimeType,
    symlinkTarget,
  };
}

export async function getFileInfo(
  filePath: string,
  options: { includeMimeType?: boolean; signal?: AbortSignal } = {}
): Promise<FileInfo> {
  const { signal } = options;
  assertNotAborted(signal);
  const { requestedPath, resolvedPath, isSymlink } =
    await validateExistingPathDetailed(filePath, signal);

  const name = path.basename(requestedPath);
  const ext = path.extname(name).toLowerCase();
  const includeMimeType = options.includeMimeType !== false;
  const mimeType = resolveMimeType(ext, includeMimeType);
  const symlinkTarget = await resolveSymlinkTarget(
    requestedPath,
    isSymlink,
    signal
  );

  const stats = await withAbort(fs.stat(resolvedPath), signal);

  return buildFileInfoResult(
    name,
    requestedPath,
    isSymlink,
    stats,
    mimeType,
    symlinkTarget
  );
}

async function getSymlinkTarget(
  pathToRead: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  assertNotAborted(signal);
  try {
    return await withAbort(fs.readlink(pathToRead), signal);
  } catch (error) {
    handleSymlinkError(error);
    return undefined;
  }
}

function handleSymlinkError(error: unknown): void {
  if (error instanceof Error && error.name === 'AbortError') {
    throw error;
  }
}
