import { createHash, randomUUID } from 'node:crypto';
import type { ReadStream, Stats } from 'node:fs';
import { createReadStream, constants as fsConstants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  chmod as fsChmod,
  cp as fsCp,
  lstat as fsLstat,
  mkdir as fsMkdir,
  open as fsOpen,
  opendir as fsOpendir,
  readFile as fsReadFile,
  readlink as fsReadlink,
  rename as fsRename,
  rm as fsRm,
  rmdir as fsRmdir,
  stat as fsStat,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { withAbort } from './concurrency.js';
import { ErrorCode, formatUnknownErrorMessage, FsError, isFsError, isNodeError } from './errors.js';
import { detectMimeFromContent } from './mime.js';
import { Logger } from './observability.js';
import type { PathGuard } from './path.js';
import type { EntryType as FileType } from './primitives.js';
import type { ReadFileResult, ReadSpec } from './read.js';
import {
  assertFileStats,
  createTooLargeError,
  normalizeSpec,
  readFileWithStats,
  readNormalized,
  STREAM_CHUNK_SIZE,
} from './read.js';
import { getMaxTextFileSize } from './util.js';

export type { FileType };
export type { Stats, ReadStream };
export type { FileHandle };

// ─── Domain primitives ────────────────────────────────────────────────────────

export interface FileInfo {
  readonly name: string;
  readonly path: string;
  readonly type: FileType;
  readonly size: number;
  readonly tokenEstimate?: number;
  readonly created: Date;
  readonly modified: Date;
  readonly accessed: Date;
  readonly permissions: string;
  readonly isHidden: boolean;
  readonly mimeType?: string;
  readonly symlinkTarget?: string;
}

// ─── File hashing ────────────────────────────────────────────────────────────

async function calculateFileContentHash(filePath: string, signal?: AbortSignal): Promise<string> {
  const hasher = createHash('sha256');
  await pipeline(createReadStream(filePath, { signal, highWaterMark: STREAM_CHUNK_SIZE }), hasher, {
    signal,
  });
  return hasher.digest('hex');
}

async function atomicWriteFile(
  filePath: string,
  content: string,
  pathGuard: PathGuard,
  options: { encoding?: BufferEncoding; signal?: AbortSignal | undefined } = {},
): Promise<{ validPath: string }> {
  const { encoding = 'utf-8', signal } = options;
  let validPath = await pathGuard.validatePathForWrite(filePath);

  try {
    const stats = await fsLstat(validPath);
    if (stats.isSymbolicLink()) {
      const target = await fsReadlink(validPath);
      const resolvedTarget = isAbsolute(target) ? target : resolve(dirname(validPath), target);
      validPath = await pathGuard.validatePathForWrite(resolvedTarget);
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  const tempSuffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const tempPath = `${validPath}.${tempSuffix}.tmp`;

  // The rename below swaps in the temp file's inode, so the target would
  // inherit fsWriteFile's default 0o666 & ~umask — silently widening a 0600
  // file to 0644 on every write. Carry the existing mode across instead.
  let existingMode: number | undefined;
  try {
    existingMode = (await fsStat(validPath)).mode & 0o777;
  } catch (error) {
    // ENOENT is the normal new-file case: the default mode is correct there.
    // Anything else (EACCES, EIO) means the mode about to be overwritten could
    // not be read, and the write will silently widen the file — say so rather
    // than swallowing it.
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      Logger.warn(
        `atomicWriteFile: cannot read the existing mode of ${validPath}; the write will use the default mode: ${formatUnknownErrorMessage(error)}`,
      );
    }
  }

  try {
    signal?.throwIfAborted();
    await fsWriteFile(tempPath, content, { encoding, signal });
    if (existingMode !== undefined) {
      await fsChmod(tempPath, existingMode);
    }
    await withAbort(fsRename(tempPath, validPath), signal);
  } catch (error) {
    try {
      await fsUnlink(tempPath);
    } catch (cleanupError) {
      Logger.warn(
        `Failed to clean up temp file ${tempPath} after write error (${formatUnknownErrorMessage(error)}): ${formatUnknownErrorMessage(cleanupError)}`,
      );
    }
    throw error;
  }
  return { validPath };
}

export function getFileType(stats: Stats): FileType {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symlink';
  return 'other';
}

export function isHidden(name: string): boolean {
  return name.startsWith('.');
}

export class GuardedFileSystem {
  readonly pathGuard: PathGuard;

  constructor(pathGuard: PathGuard) {
    this.pathGuard = pathGuard;
  }

  async stat(
    filePath: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ stats: Stats; validPath: string }> {
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    const stats = await withAbort(fsStat(validPath), options?.signal);
    return { stats, validPath };
  }

  async lstat(
    filePath: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ stats: Stats; validPath: string }> {
    const validPath = await this.pathGuard.validatePathForDelete(filePath);
    const stats = await withAbort(fsLstat(validPath), options?.signal);
    return { stats, validPath };
  }

  async readlink(
    filePath: string,
    options?: Parameters<typeof fsReadlink>[1],
  ): Promise<{ linkString: string; validPath: string }> {
    // validateExistingPath resolves through the symlink, so readlink would always
    // be handed the final target — a regular file — and fail EINVAL. This guard
    // keeps the link itself while still enforcing containment and the denylist.
    const validPath = await this.pathGuard.validatePathForDelete(filePath);
    const raw = await fsReadlink(validPath, options);
    const linkString = Buffer.isBuffer(raw) ? raw.toString('utf-8') : raw;
    return { linkString, validPath };
  }

  async mkdir(
    filePath: string,
    options?: Parameters<typeof fsMkdir>[1],
  ): Promise<{ validPath: string; result: string | undefined }> {
    const validPath = await this.pathGuard.validatePathForWrite(filePath);
    const result = await fsMkdir(validPath, options);
    return { validPath, result };
  }

  async rename(oldPath: string, newPath: string): Promise<{ validOld: string; validNew: string }> {
    // Not validateExistingPath: that resolves through a symlink, so renaming a
    // link would rename its target and leave the link dangling.
    const validOld = await this.pathGuard.validatePathForDelete(oldPath);
    const validNew = await this.pathGuard.validatePathForWrite(newPath);
    await fsRename(validOld, validNew);
    return { validOld, validNew };
  }

  async writeFile(
    filePath: string,
    content: string,
    options: { encoding?: BufferEncoding; signal?: AbortSignal | undefined } = {},
  ): Promise<{ validPath: string }> {
    return atomicWriteFile(filePath, content, this.pathGuard, options);
  }

  async rm(filePath: string, options?: Parameters<typeof fsRm>[1]): Promise<{ validPath: string }> {
    const validPath = await this.pathGuard.validatePathForDelete(filePath);
    await fsRm(validPath, options);
    return { validPath };
  }

  async rmdir(
    filePath: string,
    options?: Parameters<typeof fsRmdir>[1],
  ): Promise<{ validPath: string }> {
    const validPath = await this.pathGuard.validatePathForDelete(filePath);
    await fsRmdir(validPath, options);
    return { validPath };
  }

  async cp(
    source: string,
    destination: string,
    options?: Parameters<typeof fsCp>[2],
  ): Promise<{ validSource: string; validDest: string }> {
    // As in rename: keep the link itself so callers passing verbatimSymlinks
    // actually copy the link rather than a dereferenced target.
    const validSource = await this.pathGuard.validatePathForDelete(source);
    const validDest = await this.pathGuard.validatePathForWrite(destination);
    await fsCp(validSource, validDest, options);
    return { validSource, validDest };
  }

  async hash(filePath: string, signal?: AbortSignal): Promise<string> {
    // For hashing, we require the path to exist and be a file, so we use the stricter existing-path guard.
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    return calculateFileContentHash(validPath, signal);
  }

  async readFile(filePath: string, spec: ReadSpec): Promise<ReadFileResult> {
    const normalized = normalizeSpec(spec);
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    normalized.signal?.throwIfAborted();
    const stats = await withAbort(fsStat(validPath), normalized.signal);
    return readNormalized(filePath, validPath, stats, normalized);
  }

  async readEditableText(
    filePath: string,
    options?: { signal?: AbortSignal; tool?: string },
  ): Promise<{ validPath: string; content: string; stats: Stats }> {
    const { stats, validPath } = await this.stat(filePath, options);
    const maxSize = getMaxTextFileSize();
    if (stats.size > maxSize) {
      // `tool` labels the TOO_LARGE message so the client sees which tool refused.
      throw new FsError(
        ErrorCode.TOO_LARGE,
        `File too large for ${options?.tool ?? 'edit'} (${stats.size} bytes > ${maxSize} bytes)`,
        filePath,
        { size: stats.size, maxFileSize: maxSize },
      );
    }
    const { content } = await readFileWithStats(filePath, validPath, stats, {
      kind: 'full',
      encoding: 'utf-8',
      maxSize,
      skipBinary: true,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    return { validPath, content, stats };
  }

  async readRaw(
    filePath: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ content: Buffer; mimeType: string; isBinary: boolean }> {
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    const stats = await withAbort(fsStat(validPath), options?.signal);
    assertFileStats(filePath, stats);
    // Enforce size limit before reading to avoid loading large files into memory.
    // Binary detection is best-effort, but this is a hard limit.
    const maxTextFileSize = getMaxTextFileSize();
    if (stats.size > maxTextFileSize) {
      throw createTooLargeError(stats.size, maxTextFileSize, filePath);
    }
    const content = await withAbort(fsReadFile(validPath), options?.signal);
    const mimeInfo = detectMimeFromContent(validPath, content);
    return {
      content,
      mimeType: mimeInfo.mimeType,
      isBinary: mimeInfo.kind !== 'text',
    };
  }

  async open(
    filePath: string,
    flags: string | number,
    mode?: string | number,
  ): Promise<FileHandle> {
    // Only a plain read-only open ('r' / O_RDONLY) uses the existing-path guard.
    // Every other flag (write, append, read-write, sync, numeric) is treated as
    // write-capable and routed through the stricter write guard.
    const isReadOnly = flags === 'r' || flags === fsConstants.O_RDONLY;
    const validPath = isReadOnly
      ? await this.pathGuard.validateExistingPath(filePath)
      : await this.pathGuard.validatePathForWrite(filePath);
    return fsOpen(validPath, flags, mode);
  }

  async createReadStream(
    filePath: string,
    options?: Parameters<typeof createReadStream>[1],
  ): Promise<ReadStream> {
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    return createReadStream(validPath, options);
  }

  // Single resolution + stat: validateExistingPathDetailed resolves the real
  // path (following symlinks, re-checking sensitivity) once, then we stat the
  // resolved target. Replaces the tool-side validateExistingPathDetailed +
  // fs.stat pair that re-validated through the free stat() guard.
  async statDetailed(
    filePath: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ requestedPath: string; isSymlink: boolean; stats: Stats }> {
    const { requestedPath, resolvedPath, isSymlink } =
      await this.pathGuard.validateExistingPathDetailed(filePath);
    const stats = await withAbort(fsStat(resolvedPath), options?.signal);
    return { requestedPath, isSymlink, stats };
  }

  async hasChildrenUnchecked(dirPath: string): Promise<boolean> {
    const dir = await fsOpendir(dirPath);
    try {
      const entry = await dir.read();
      return entry !== null;
    } finally {
      await dir.close().catch((closeErr: unknown) => {
        Logger.warn(
          `Failed to close dir handle for ${dirPath}: ${formatUnknownErrorMessage(closeErr)}`,
        );
      });
    }
  }
}

export interface StatPath {
  stat(filePath: string, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/**
 * Returns whether `path` exists, treating "not found" as absent and logging any
 * other stat failure. Used for TOCTOU re-checks between plan and execute phases.
 */
export async function destExists(fs: StatPath, path: string, label: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (err) {
    const missing =
      (isNodeError(err) && err.code === 'ENOENT') ||
      (isFsError(err) && err.code === ErrorCode.NOT_FOUND);
    if (!missing) {
      Logger.warn(`${label}: dest stat failed unexpectedly for "${path}": ${String(err)}`);
    }
    return false;
  }
}
