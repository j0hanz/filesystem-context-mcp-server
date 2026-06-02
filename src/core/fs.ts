import { isUtf8 } from 'node:buffer';
import { type BinaryToTextEncoding, createHash, randomUUID } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import {
  type FileHandle,
  cp as fsCp,
  glob as fsGlob,
  lstat as fsLstat,
  mkdir as fsMkdir,
  open as fsOpen,
  readFile as fsReadFile,
  readlink as fsReadlink,
  rename as fsRename,
  rm as fsRm,
  rmdir as fsRmdir,
  stat as fsStat,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { extname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { text } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';

// fs-walk.ts

import ignore, { type Ignore } from 'ignore';

import type { FileType } from '../schema.js';
import { assertNotAborted, withAbort } from './concurrency.js';
import { ErrorCode, formatUnknownErrorMessage, FsError, isNodeError } from './errors.js';
import { Logger, startPerfMeasure, withOpsTrace } from './observability.js';
import type { PathGuard } from './path.js';
import { toPosixPath } from './path.js';
import { BINARY_CHECK_BUFFER_SIZE, KNOWN_BINARY_EXTENSIONS, MAX_TEXT_FILE_SIZE } from './util.js';

// Re-export FileType from schema for external consumers
export type { FileType };

const READ_ONLY_FILE_FLAG = 'r';
const STREAM_CHUNK_SIZE = 64 * 1024;

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

// ─── Guarded Primitives ──────────────────────────────────────────────────────

export async function stat(
  filePath: string,
  pathGuard: PathGuard,
  options?: { signal?: AbortSignal },
): Promise<{ stats: Stats; validPath: string }> {
  const validPath = await pathGuard.validateExistingPath(filePath);
  const stats = await withAbort(fsStat(validPath), options?.signal);
  return { stats, validPath };
}

async function lstat(
  filePath: string,
  pathGuard: PathGuard,
  options?: { signal?: AbortSignal },
): Promise<{ stats: Stats; validPath: string }> {
  const validPath = await pathGuard.validateExistingPath(filePath);
  const stats = await withAbort(fsLstat(validPath), options?.signal);
  return { stats, validPath };
}

export async function mkdir(
  filePath: string,
  pathGuard: PathGuard,
  options?: Parameters<typeof fsMkdir>[1],
): Promise<{ validPath: string; result: string | undefined }> {
  const validPath = await pathGuard.validatePathForWrite(filePath);
  const result = await fsMkdir(validPath, options);
  return { validPath, result };
}

async function rename(
  oldPath: string,
  newPath: string,
  pathGuard: PathGuard,
): Promise<{ validOld: string; validNew: string }> {
  const validOld = await pathGuard.validateExistingPath(oldPath);
  const validNew = await pathGuard.validatePathForWrite(newPath);
  await fsRename(validOld, validNew);
  return { validOld, validNew };
}

async function rm(
  filePath: string,
  pathGuard: PathGuard,
  options?: Parameters<typeof fsRm>[1],
): Promise<{ validPath: string }> {
  const validPath = await pathGuard.validatePathForWrite(filePath);
  await fsRm(validPath, options);
  return { validPath };
}

async function rmdir(
  filePath: string,
  pathGuard: PathGuard,
  options?: Parameters<typeof fsRmdir>[1],
): Promise<{ validPath: string }> {
  const validPath = await pathGuard.validatePathForWrite(filePath);
  await fsRmdir(validPath, options);
  return { validPath };
}

export async function readlink(
  filePath: string,
  pathGuard: PathGuard,
  options?: Parameters<typeof fsReadlink>[1],
): Promise<{ linkString: string; validPath: string }> {
  const validPath = await pathGuard.validateExistingPath(filePath);
  const linkString = (await fsReadlink(validPath, options)) as string;
  return { linkString, validPath };
}

async function cp(
  source: string,
  destination: string,
  pathGuard: PathGuard,
  options?: Parameters<typeof fsCp>[2],
): Promise<{ validSource: string; validDest: string }> {
  const validSource = await pathGuard.validateExistingPath(source);
  const validDest = await pathGuard.validatePathForWrite(destination);
  await fsCp(validSource, validDest, options);
  return { validSource, validDest };
}

// ─── Input validation ────────────────────────────────────────────────────────

function assertPositiveSafeIntegerOption(name: string, value: unknown, message?: string): void {
  if (value === undefined) return;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new FsError(ErrorCode.INVALID_INPUT, message ?? `${name} must be a positive integer`);
  }
}

// ─── Binary detection ────────────────────────────────────────────────────────

function hasKnownBinaryExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return KNOWN_BINARY_EXTENSIONS.has(ext);
}

async function openReadableFileHandle(filePath: string, signal?: AbortSignal): Promise<FileHandle> {
  return withAbort(fsOpen(filePath, READ_ONLY_FILE_FLAG), signal);
}

async function readProbe(handle: FileHandle, signal?: AbortSignal): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(BINARY_CHECK_BUFFER_SIZE);
  const { bytesRead } = await withAbort(
    handle.read(buffer, 0, BINARY_CHECK_BUFFER_SIZE, 0),
    signal,
  );

  if (bytesRead === 0) {
    return Buffer.alloc(0);
  }

  return buffer.subarray(0, bytesRead);
}

function hasUtf16Bom(slice: Buffer): boolean {
  return (
    slice.length >= 2 &&
    ((slice[0] === 0xff && slice[1] === 0xfe) || (slice[0] === 0xfe && slice[1] === 0xff))
  );
}

function isBinarySlice(slice: Buffer): boolean {
  if (slice.length === 0) return false;
  if (hasUtf16Bom(slice)) return false;
  if (slice.includes(0)) return true;
  return !isUtf8(slice);
}

export async function isProbablyBinary(
  filePath: string,
  existingHandle?: FileHandle,
  signal?: AbortSignal,
): Promise<boolean> {
  if (hasKnownBinaryExtension(filePath)) {
    return true;
  }

  if (existingHandle) {
    const slice = await readProbe(existingHandle, signal);
    return isBinarySlice(slice);
  }

  await using handle = await openReadableFileHandle(filePath, signal);
  const slice = await readProbe(handle, signal);
  return isBinarySlice(slice);
}

// ─── File hashing ────────────────────────────────────────────────────────────

export async function calculateFileContentHash(
  filePath: string,
  signal?: AbortSignal,
): Promise<string>;
export async function calculateFileContentHash(
  filePath: string,
  signal: AbortSignal | undefined,
  encoding: BinaryToTextEncoding,
): Promise<string>;
export async function calculateFileContentHash(
  filePath: string,
  signal: AbortSignal | undefined,
  encoding: null,
): Promise<Buffer>;
export async function calculateFileContentHash(
  filePath: string,
  signal?: AbortSignal,
  encoding: BinaryToTextEncoding | null = 'hex',
): Promise<string | Buffer> {
  const hasher = createHash('sha256');
  await pipeline(createReadStream(filePath, { signal, highWaterMark: STREAM_CHUNK_SIZE }), hasher, {
    signal,
  });
  return encoding === null ? hasher.digest() : hasher.digest(encoding);
}

// ─── File reading ────────────────────────────────────────────────────────────

type ReadMode = 'head' | 'full' | 'range' | 'tail' | 'byteRange';

export type ReadSpec =
  | {
      kind: 'full';
      encoding?: BufferEncoding;
      maxSize?: number;
      skipBinary?: boolean;
      signal?: AbortSignal;
    }
  | {
      kind: 'head';
      lines: number;
      encoding?: BufferEncoding;
      maxSize?: number;
      skipBinary?: boolean;
      signal?: AbortSignal;
    }
  | {
      kind: 'tail';
      lines: number;
      encoding?: BufferEncoding;
      maxSize?: number;
      skipBinary?: boolean;
      signal?: AbortSignal;
    }
  | {
      kind: 'range';
      start: number;
      end?: number;
      encoding?: BufferEncoding;
      maxSize?: number;
      skipBinary?: boolean;
      signal?: AbortSignal;
    }
  | {
      kind: 'byteRange';
      offset?: number;
      length?: number;
      encoding?: BufferEncoding;
      maxSize?: number;
      skipBinary?: boolean;
      signal?: AbortSignal;
    };

interface NormalizedOptions {
  encoding: BufferEncoding;
  maxSize: number;
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
  skipBinary: boolean;
  signal?: AbortSignal;
  offset?: number;
  length?: number;
}

interface ReadContentOptions {
  encoding: BufferEncoding;
  maxSize: number;
  signal?: AbortSignal;
}

interface PartialReadResult {
  content: string;
  truncated: boolean;
  linesRead: number;
  hasMoreLines: boolean;
}

export interface ReadFileResult {
  path: string;
  content: string;
  truncated: boolean;
  totalLines?: number;
  readMode: ReadMode;
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
  linesRead?: number;
  hasMoreLines?: boolean;
  // Byte-range fields
  offset?: number;
  bytesRead?: number;
  reachedEOF?: boolean;
}

function normalizeSpec(spec: ReadSpec): { normalized: NormalizedOptions; mode: ReadMode } {
  if (spec.maxSize !== undefined) {
    assertPositiveSafeIntegerOption('maxSize', spec.maxSize, 'maxSize must be at least 1');
  }

  const base: NormalizedOptions = {
    encoding: spec.encoding ?? 'utf-8',
    maxSize: Math.min(spec.maxSize ?? MAX_TEXT_FILE_SIZE, MAX_TEXT_FILE_SIZE),
    skipBinary: spec.skipBinary ?? false,
    ...(spec.signal ? { signal: spec.signal } : {}),
  };

  assertNotAborted(spec.signal);

  switch (spec.kind) {
    case 'head':
      assertPositiveSafeIntegerOption('lines', spec.lines, 'lines must be at least 1');
      return { normalized: { ...base, head: spec.lines }, mode: 'head' };
    case 'tail':
      assertPositiveSafeIntegerOption('lines', spec.lines, 'lines must be at least 1');
      return { normalized: { ...base, tail: spec.lines }, mode: 'tail' };
    case 'range': {
      assertPositiveSafeIntegerOption('start', spec.start, 'start must be at least 1');
      if (spec.end !== undefined) {
        assertPositiveSafeIntegerOption('end', spec.end, 'end must be at least 1');
        if (spec.end < spec.start) {
          throw new FsError(
            ErrorCode.INVALID_INPUT,
            'end must be greater than or equal to start (default: 1)',
          );
        }
      }
      return {
        normalized: {
          ...base,
          startLine: spec.start,
          ...(spec.end !== undefined ? { endLine: spec.end } : {}),
        },
        mode: 'range',
      };
    }
    case 'byteRange': {
      if (spec.offset !== undefined && spec.offset < 0) {
        throw new FsError(ErrorCode.INVALID_INPUT, 'offset must be >= 0');
      }
      if (spec.length !== undefined && spec.length < 1) {
        throw new FsError(ErrorCode.INVALID_INPUT, 'length must be >= 1');
      }
      return {
        normalized: {
          ...base,
          ...(spec.offset !== undefined ? { offset: spec.offset } : {}),
          ...(spec.length !== undefined ? { length: spec.length } : {}),
        },
        mode: 'byteRange',
      };
    }
    case 'full':
      return { normalized: base, mode: 'full' };
  }
}

function buildReadContentOptions(normalized: NormalizedOptions): ReadContentOptions {
  const result: ReadContentOptions = {
    encoding: normalized.encoding,
    maxSize: normalized.maxSize,
  };
  if (normalized.signal) result.signal = normalized.signal;
  return result;
}

function createTooLargeError(bytesRead: number, maxSize: number, requestedPath: string): FsError {
  return new FsError(
    ErrorCode.TOO_LARGE,
    `File exceeds size limit (${bytesRead} > ${maxSize} bytes)`,
    requestedPath,
    { size: bytesRead, maxSize },
  );
}

export async function readFileBufferWithLimit(
  handle: FileHandle,
  maxSize: number,
  requestedPath: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const stream = handle.createReadStream({
    start: 0,
    highWaterMark: STREAM_CHUNK_SIZE,
    autoClose: false,
    emitClose: false,
    signal,
  });

  const chunks: Buffer[] = [];
  let totalSize = 0;

  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      totalSize += buffer.length;

      if (totalSize > maxSize) {
        stream.destroy();
        throw createTooLargeError(totalSize, maxSize, requestedPath);
      }

      chunks.push(buffer);
    }
  } finally {
    if (!stream.destroyed) {
      stream.destroy();
    }
  }

  return Buffer.concat(chunks, totalSize);
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  let count = 1;
  let pos = content.indexOf('\n');
  while (pos !== -1) {
    count++;
    pos = content.indexOf('\n', pos + 1);
  }
  return count;
}

async function peekHasMore(iterator: AsyncIterator<string>): Promise<boolean> {
  const { done } = await iterator.next();
  return !done;
}

async function readRangeContent(
  handle: FileHandle,
  startLine: number,
  endLine: number | undefined,
  options: ReadContentOptions,
): Promise<PartialReadResult> {
  assertNotAborted(options.signal);

  const lines: string[] = [];
  let lineNumber = 0;
  let estimatedBytes = 0;
  const newlineBytes = Buffer.byteLength('\n', options.encoding);
  const stopAt = endLine ?? Number.POSITIVE_INFINITY;

  let hasMoreLines = false;
  let stoppedByLimit = false;

  const iterator = handle
    .readLines({ encoding: options.encoding, signal: options.signal })
    [Symbol.asyncIterator]();

  try {
    for (;;) {
      const { value: line, done } = await iterator.next();
      if (done) {
        break;
      }
      lineNumber++;

      if (lineNumber < startLine) {
        continue;
      }

      if (lineNumber > stopAt) {
        hasMoreLines = true;
        break;
      }

      lines.push(line);

      estimatedBytes += Buffer.byteLength(line, options.encoding) + newlineBytes;
      if (estimatedBytes >= options.maxSize) {
        stoppedByLimit = true;
        hasMoreLines = await peekHasMore(iterator);
        break;
      }

      if (lineNumber === stopAt) {
        hasMoreLines = await peekHasMore(iterator);
        break;
      }
    }
  } finally {
    await iterator.return?.();
  }

  return {
    content: lines.join('\n'),
    truncated: stoppedByLimit || hasMoreLines,
    linesRead: lines.length,
    hasMoreLines,
  };
}

async function readTailContent(
  handle: FileHandle,
  tail: number,
  options: ReadContentOptions,
): Promise<PartialReadResult> {
  assertNotAborted(options.signal);

  const ring: string[] = new Array<string>(tail);
  let totalLines = 0;
  let head = 0;
  let size = 0;

  for await (const line of handle.readLines({
    encoding: options.encoding,
    signal: options.signal,
  })) {
    ring[head] = line;
    head = (head + 1) % tail;
    if (size < tail) size++;
    totalLines++;
  }

  const lines: string[] = new Array<string>(size);
  const start = size < tail ? 0 : head;
  for (let i = 0; i < size; i++) {
    lines[i] = ring[(start + i) % tail] ?? '';
  }

  // Enforce maxSize by dropping oldest lines if necessary
  let totalBytes = 0;
  const newlineBytes = Buffer.byteLength('\n', options.encoding);
  let linesToKeep = 0;

  for (let i = size - 1; i >= 0; i--) {
    const bytes = Buffer.byteLength(lines[i] ?? '', options.encoding) + newlineBytes;
    if (totalBytes + bytes > options.maxSize && totalBytes > 0) {
      break;
    }
    totalBytes += bytes;
    linesToKeep++;
  }

  const finalLines = lines.slice(size - linesToKeep);
  const content = finalLines.join('\n');
  const linesRead = finalLines.length;
  const hasMoreLines = totalLines > linesRead;

  return {
    content,
    truncated: hasMoreLines,
    linesRead,
    hasMoreLines,
  };
}

async function readFullContent(
  handle: FileHandle,
  encoding: BufferEncoding,
  maxSize: number,
  requestedPath: string,
  signal?: AbortSignal,
): Promise<{ content: string; totalLines: number }> {
  const buffer = await readFileBufferWithLimit(handle, maxSize, requestedPath, signal);
  const content = buffer.toString(encoding);
  return { content, totalLines: countLines(content) };
}

async function assertNotBinary(
  validPath: string,
  filePath: string,
  handle: FileHandle,
  normalized: NormalizedOptions,
): Promise<void> {
  assertNotAborted(normalized.signal);
  const isBinary = await isProbablyBinary(validPath, handle, normalized.signal);
  if (!isBinary) return;
  throw new FsError(ErrorCode.INVALID_INPUT, 'Binary file detected.', filePath);
}

function assertSizeWithinLimit(size: number, maxSize: number, filePath: string): void {
  if (size <= maxSize) return;
  throw new FsError(
    ErrorCode.TOO_LARGE,
    `File too large (${size} > ${maxSize} bytes). Use head to preview.`,
    filePath,
    { size, maxSize },
  );
}

interface ReadModeContext {
  handle: FileHandle;
  validPath: string;
  filePath: string;
  stats: Stats;
  normalized: NormalizedOptions;
  mode: ReadMode;
}

class FileReader {
  private readonly context: ReadModeContext;

  private constructor(context: ReadModeContext) {
    this.context = context;
  }

  static async read(context: ReadModeContext): Promise<ReadFileResult> {
    const reader = new FileReader(context);
    switch (context.mode) {
      case 'head':
        return reader.executeHeadRead();
      case 'range':
        return reader.executeRangeRead();
      case 'full':
        return reader.executeFullRead();
      case 'tail':
        return reader.executeTailRead();
      case 'byteRange':
        return reader.executeByteRangeRead();
    }
  }

  private requireOption<K extends 'head' | 'tail' | 'startLine'>(
    key: K,
  ): NonNullable<NormalizedOptions[K]> {
    const value = this.context.normalized[key];
    if (value !== undefined) {
      return value;
    }
    throw new FsError(ErrorCode.INVALID_INPUT, `Missing ${key} option`, this.context.filePath);
  }

  private async executeHeadRead(): Promise<ReadFileResult> {
    const head = this.requireOption('head');
    const readOptions = buildReadContentOptions(this.context.normalized);
    const { content, truncated, linesRead, hasMoreLines } = await readRangeContent(
      this.context.handle,
      1,
      head,
      readOptions,
    );

    return {
      path: this.context.validPath,
      content,
      truncated,
      readMode: 'head',
      head,
      linesRead,
      hasMoreLines,
    };
  }

  private async executeRangeRead(): Promise<ReadFileResult> {
    const startLine = this.requireOption('startLine');
    const { endLine } = this.context.normalized;
    const readOptions = buildReadContentOptions(this.context.normalized);
    const { content, truncated, linesRead, hasMoreLines } = await readRangeContent(
      this.context.handle,
      startLine,
      endLine,
      readOptions,
    );

    return {
      path: this.context.validPath,
      content,
      truncated,
      readMode: 'range',
      startLine,
      ...(endLine !== undefined ? { endLine } : {}),
      linesRead,
      hasMoreLines,
    };
  }

  private async executeFullRead(): Promise<ReadFileResult> {
    assertSizeWithinLimit(
      this.context.stats.size,
      this.context.normalized.maxSize,
      this.context.filePath,
    );
    const { content, totalLines } = await readFullContent(
      this.context.handle,
      this.context.normalized.encoding,
      this.context.normalized.maxSize,
      this.context.filePath,
      this.context.normalized.signal,
    );

    return {
      path: this.context.validPath,
      content,
      truncated: false,
      totalLines,
      readMode: 'full',
      linesRead: totalLines,
      hasMoreLines: false,
    };
  }

  private async executeTailRead(): Promise<ReadFileResult> {
    const tail = this.requireOption('tail');
    const readOptions = buildReadContentOptions(this.context.normalized);
    const { content, truncated, linesRead, hasMoreLines } = await readTailContent(
      this.context.handle,
      tail,
      readOptions,
    );

    return {
      path: this.context.validPath,
      content,
      truncated,
      readMode: 'tail',
      tail,
      linesRead,
      hasMoreLines,
    };
  }

  private async executeByteRangeRead(): Promise<ReadFileResult> {
    const start = this.context.normalized.offset ?? 0;
    const fileSize = this.context.stats.size;

    // Past EOF — return empty immediately
    if (start >= fileSize) {
      return {
        path: this.context.validPath,
        content: '',
        truncated: false,
        readMode: 'byteRange',
        offset: start,
        bytesRead: 0,
        reachedEOF: true,
      };
    }

    const { length } = this.context.normalized;
    let end: number | undefined;
    let reachedEOF: boolean;

    if (length !== undefined) {
      const requestedEnd = start + length - 1; // createReadStream end is inclusive
      if (requestedEnd >= fileSize) {
        end = fileSize - 1;
        reachedEOF = true;
      } else {
        end = requestedEnd;
        reachedEOF = false;
      }
    } else {
      // No length → read to EOF
      reachedEOF = true;
    }

    const actualEnd = end ?? fileSize - 1;
    const bytesRead = actualEnd - start + 1;

    if (bytesRead > this.context.normalized.maxSize) {
      throw createTooLargeError(bytesRead, this.context.normalized.maxSize, this.context.filePath);
    }

    const stream = this.context.handle.createReadStream({
      encoding: this.context.normalized.encoding,
      start,
      ...(end !== undefined ? { end } : {}),
      signal: this.context.normalized.signal,
    });

    const content = await text(stream);

    return {
      path: this.context.validPath,
      content,
      truncated: false,
      readMode: 'byteRange',
      offset: start,
      bytesRead,
      reachedEOF,
    };
  }
}

function assertFileStats(filePath: string, stats: Stats): void {
  if (!stats.isFile()) {
    throw new FsError(ErrorCode.NOT_FILE, 'Not a regular file', filePath);
  }
}

async function readFileWithStatsInternal(
  filePath: string,
  validPath: string,
  stats: Stats,
  normalized: NormalizedOptions,
  mode: ReadMode,
): Promise<ReadFileResult> {
  assertNotAborted(normalized.signal);

  assertFileStats(filePath, stats);

  await using handle = await openReadableFileHandle(validPath, normalized.signal);

  if (normalized.skipBinary) {
    await assertNotBinary(validPath, filePath, handle, normalized);
  }
  assertNotAborted(normalized.signal);

  return await FileReader.read({ handle, validPath, filePath, stats, normalized, mode });
}

export async function readFileRaw(
  filePath: string,
  pathGuard: PathGuard,
  options?: { signal?: AbortSignal },
): Promise<{ content: Buffer; mimeType: string; isBinary: boolean }> {
  const validPath = await pathGuard.validateExistingPath(filePath);
  const stats = await withAbort(fsStat(validPath), options?.signal);
  assertFileStats(filePath, stats);
  const content = await withAbort(fsReadFile(validPath), options?.signal);
  const mimeInfo = detectMimeType(validPath, content.subarray(0, MIME_SAMPLE_SIZE));
  return {
    content,
    mimeType: mimeInfo.mimeType,
    isBinary: mimeInfo.kind !== 'text',
  };
}

export async function readFileWithStats(
  filePath: string,
  validPath: string,
  stats: Stats,
  spec: ReadSpec | undefined,
): Promise<ReadFileResult> {
  const { normalized, mode } = normalizeSpec(spec ?? { kind: 'full' });
  return readFileWithStatsInternal(filePath, validPath, stats, normalized, mode);
}

async function readFile(
  filePath: string,
  spec: ReadSpec,
  pathGuard: PathGuard,
): Promise<ReadFileResult> {
  const { normalized, mode } = normalizeSpec(spec);
  const validPath = await pathGuard.validateExistingPath(filePath);
  assertNotAborted(normalized.signal);
  const stats = await withAbort(fsStat(validPath), normalized.signal);
  return readFileWithStatsInternal(filePath, validPath, stats, normalized, mode);
}

export async function atomicWriteFile(
  filePath: string,
  content: string,
  pathGuard: PathGuard,
  options: { encoding?: BufferEncoding; signal?: AbortSignal | undefined } = {},
): Promise<{ validPath: string }> {
  const { encoding = 'utf-8', signal } = options;
  const validPath = await pathGuard.validatePathForWrite(filePath);
  const tempPath = `${validPath}.${randomUUID()}.tmp`;

  try {
    assertNotAborted(signal);
    await fsWriteFile(tempPath, content, { encoding, signal });
    await withAbort(fsRename(tempPath, validPath), signal);
  } catch (error) {
    try {
      await fsUnlink(tempPath);
    } catch (cleanupError) {
      // temp file may persist on disk if cleanup fails — contains the new content
      Logger.warn(
        `Failed to clean up temp file ${tempPath}: ${formatUnknownErrorMessage(cleanupError)}`,
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

export function needsStatsForSort(sortBy: string): boolean {
  return sortBy === 'size' || sortBy === 'modified';
}

const collator = new Intl.Collator(undefined, { numeric: true });

export function withOptionalStoppedReason<T extends object, R extends string>(
  summary: T,
  stoppedReason: R | undefined,
): T & { stoppedReason?: R } {
  if (stoppedReason === undefined) {
    return summary;
  }
  return { ...summary, stoppedReason };
}

export interface DirentLike {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export type EntryType = 'file' | 'directory' | 'symlink' | 'other';

export function resolveEntryType(dirent: DirentLike): EntryType {
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  if (dirent.isSymbolicLink()) return 'symlink';
  return 'other';
}

export function resolveStopReason<R extends string>(options: {
  signal: AbortSignal;
  current: number;
  max: number;
  abortedReason: R;
  maxReason: R;
}): R | undefined {
  if (options.signal.aborted) return options.abortedReason;
  if (options.current >= options.max) return options.maxReason;
  return undefined;
}

export function compareStringValues(left?: string, right?: string): number {
  if (left === right) return 0;
  return collator.compare(left ?? '', right ?? '');
}

export function compareOptionalNumberDesc(
  left: number | undefined,
  right: number | undefined,
  tieBreak: () => number,
): number {
  const diff = (right ?? 0) - (left ?? 0);
  if (diff !== 0) return diff;
  return tieBreak();
}

export function stableSortByDerivedString<T>(
  items: T[],
  derive: (item: T) => string,
  tieBreak: (left: T, right: T) => number,
): void {
  const len = items.length;
  if (len <= 1) return;

  const derived = new Array<string>(len);
  const indices = new Int32Array(len);

  for (let i = 0; i < len; i++) {
    const item = items[i];
    if (item !== undefined) {
      derived[i] = derive(item);
    }
    indices[i] = i;
  }

  indices.sort((a, b) => {
    const itemA = items[a];
    const itemB = items[b];

    if (itemA === undefined && itemB === undefined) return 0;
    if (itemA === undefined) return 1;
    if (itemB === undefined) return -1;

    const derivedA = derived[a] ?? '';
    const derivedB = derived[b] ?? '';

    if (derivedA !== derivedB) {
      const derivedCompare = collator.compare(derivedA, derivedB);
      if (derivedCompare !== 0) return derivedCompare;
    }

    const tiedCompare = tieBreak(itemA, itemB);
    if (tiedCompare !== 0) return tiedCompare;

    return a - b;
  });

  const sortedItems = new Array<T>(len);
  for (let i = 0; i < len; i++) {
    const idx = indices[i];
    sortedItems[i] = items[idx ?? 0] as T;
  }
  for (let i = 0; i < len; i++) {
    items[i] = sortedItems[i] as T;
  }
}

export interface EntryAccessDependencies {
  normalizePath: (inputPath: string) => string;
  isPathWithinDirectories: (normalizedPath: string, rootDirectories: readonly string[]) => boolean;
  isSensitivePath: (requestedPath: string, resolvedPath: string) => boolean;
  validateSymlinkPath: (
    inputPath: string,
    signal: AbortSignal,
  ) => Promise<{ requestedPath: string; resolvedPath: string }>;
}

export async function isEntryAccessibleByType(
  entryPath: string,
  entryType: EntryType,
  rootDirectories: readonly string[],
  signal: AbortSignal,
  deps: EntryAccessDependencies,
): Promise<boolean> {
  if (entryType !== 'symlink') {
    const normalizedPath = deps.normalizePath(entryPath);
    if (!deps.isPathWithinDirectories(normalizedPath, rootDirectories)) {
      return false;
    }
    return !deps.isSensitivePath(entryPath, normalizedPath);
  }

  try {
    const validated = await deps.validateSymlinkPath(entryPath, signal);
    return !deps.isSensitivePath(validated.requestedPath, validated.resolvedPath);
  } catch {
    return false;
  }
}

function parseGitignoreLines(contents: string): string[] {
  const lines: string[] = [];
  const parts = contents.split(/\r?\n/u);
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      lines.push(trimmed);
    }
  }
  return lines;
}

export async function loadRootGitignore(
  root: string,
  signal?: AbortSignal,
): Promise<Ignore | null> {
  const gitignorePath = join(root, '.gitignore');

  try {
    const contents = await fsReadFile(gitignorePath, {
      encoding: 'utf-8',
      signal,
    });
    const matcher = ignore();
    matcher.add(parseGitignoreLines(contents));
    return matcher;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function isIgnoredByGitignore(
  matcher: Ignore,
  root: string,
  absolutePath: string,
  options: { isDirectory?: boolean; relativePath?: string } = {},
): boolean {
  let { relativePath } = options;
  relativePath ??= relative(root, absolutePath);
  if (relativePath.length === 0) return false;

  const normalized = toPosixPath(relativePath);
  if (options.isDirectory) {
    return matcher.ignores(normalized.endsWith('/') ? normalized : `${normalized}/`);
  }
  return matcher.ignores(normalized);
}

interface GlobDirentLike extends DirentLike {
  name: string;
  parentPath?: string;
}

export interface GlobEntry {
  path: string;
  relativePath?: string;
  dirent: DirentLike;
  stats?: Stats;
}

interface GlobEntriesOptions {
  cwd: string;
  pattern: string;
  excludePatterns: readonly string[];
  includeHidden: boolean;
  baseNameMatch: boolean;
  caseSensitiveMatch: boolean;
  maxDepth?: number;
  followSymbolicLinks: boolean;
  onlyFiles: boolean;
  stats: boolean;
  suppressErrors?: boolean;
  respectGitignore?: boolean;
}

type GlobMatch = string | GlobDirentLike;

interface NormalizedGlob {
  cwd: string;
  patterns: readonly string[];
  exclude: readonly string[];
  useDirents: boolean;
  suppressErrors: boolean;
  maxDepth?: number;
  respectGitignore: boolean;
}

const GLOB_MAGIC_RE = /[*?[\]{}!]/u;
const DEFAULT_MAX_HIDDEN_DEPTH = 10;
const GLOB_BATCH_CONCURRENCY = 64;
const SEP = '/';
const DOT_CHAR_CODE = 46;
const GLOB_BOOLEAN_OPTION_KEYS: readonly (keyof GlobEntriesOptions)[] = [
  'includeHidden',
  'baseNameMatch',
  'caseSensitiveMatch',
  'followSymbolicLinks',
  'onlyFiles',
  'stats',
];

function normalizePattern(pattern: string, baseNameMatch: boolean): string {
  const normalized = toPosixPath(pattern);

  if (!baseNameMatch) return normalized;
  if (normalized.includes(SEP)) return normalized;
  return `**/${normalized}`;
}

function splitPatternPrefix(normalizedPattern: string): {
  prefix: string;
  remainder: string;
} {
  if (!GLOB_MAGIC_RE.test(normalizedPattern)) {
    return { prefix: '', remainder: normalizedPattern };
  }

  const segments = normalizedPattern.split(SEP);
  const splitIndex = segments.findIndex((seg) => GLOB_MAGIC_RE.test(seg));

  if (splitIndex <= 0) {
    return { prefix: '', remainder: normalizedPattern };
  }

  return {
    prefix: segments.slice(0, splitIndex).join(SEP) + SEP,
    remainder: segments.slice(splitIndex).join(SEP),
  };
}

function addFirstDotSegment(patterns: Set<string>, prefix: string, remainder: string): void {
  if (remainder.length === 0) return;
  const segments = remainder.split(SEP);
  const idx = segments.findIndex((seg) => seg !== '**' && seg.length > 0);

  if (idx !== -1) {
    const original = segments[idx];
    if (original && original.charCodeAt(0) !== DOT_CHAR_CODE) {
      const newSegments = [...segments];
      newSegments[idx] = `.${original}`;
      patterns.add(`${prefix}${newSegments.join(SEP)}`);
    }
  }
}

function expandHiddenGlobstars(
  patterns: Set<string>,
  prefix: string,
  remainder: string,
  maxDepth: number,
): void {
  if (!remainder.startsWith('**/')) return;

  const afterGlobstar = remainder.slice(3);
  const addDotFile = afterGlobstar.length > 0 && afterGlobstar.charCodeAt(0) !== DOT_CHAR_CODE;

  let depthPrefix = '';
  for (let depth = 0; depth <= maxDepth; depth++) {
    patterns.add(`${prefix}${depthPrefix}.*/**/${afterGlobstar}`);
    if (addDotFile) patterns.add(`${prefix}${depthPrefix}.${afterGlobstar}`);
    depthPrefix += '*/';
  }
}

function buildHiddenPatterns(normalizedPattern: string, maxDepth: number): readonly string[] {
  const patterns = new Set<string>([normalizedPattern]);
  const { prefix, remainder } = splitPatternPrefix(normalizedPattern);

  addFirstDotSegment(patterns, prefix, remainder);
  expandHiddenGlobstars(patterns, prefix, remainder, maxDepth);

  return Array.from(patterns);
}

function assertOptionsShape(options: GlobEntriesOptions): void {
  const optsUnknown = options as unknown;
  if (typeof optsUnknown !== 'object' || optsUnknown === null) {
    throw new TypeError('globEntries: options must be an object');
  }

  const opts = optsUnknown as Record<string, unknown>;

  if (typeof opts['cwd'] !== 'string')
    throw new TypeError('globEntries: options.cwd must be a string');
  if (typeof opts['pattern'] !== 'string')
    throw new TypeError('globEntries: options.pattern must be a string');

  if (
    !Array.isArray(opts['excludePatterns']) ||
    opts['excludePatterns'].some((p) => typeof p !== 'string')
  ) {
    throw new TypeError('globEntries: options.excludePatterns must be an array of strings');
  }

  for (const key of GLOB_BOOLEAN_OPTION_KEYS) {
    if (typeof opts[key] !== 'boolean') {
      throw new TypeError(`globEntries: options.${key} must be a boolean`);
    }
  }

  if (
    opts['maxDepth'] !== undefined &&
    (!Number.isFinite(opts['maxDepth']) || typeof opts['maxDepth'] !== 'number')
  ) {
    throw new TypeError('globEntries: options.maxDepth must be a finite number');
  }

  if (opts['suppressErrors'] !== undefined && typeof opts['suppressErrors'] !== 'boolean') {
    throw new TypeError('globEntries: options.suppressErrors must be a boolean');
  }

  if (opts['respectGitignore'] !== undefined && typeof opts['respectGitignore'] !== 'boolean') {
    throw new TypeError('globEntries: options.respectGitignore must be a boolean');
  }
}

function normalizeGlobOptions(options: GlobEntriesOptions): NormalizedGlob {
  const cwd = resolve(options.cwd);
  const normalizedPattern = normalizePattern(options.pattern, options.baseNameMatch);

  const patterns = options.includeHidden
    ? buildHiddenPatterns(normalizedPattern, options.maxDepth ?? DEFAULT_MAX_HIDDEN_DEPTH)
    : [normalizedPattern];

  const normalized: NormalizedGlob = {
    cwd,
    patterns,
    exclude: options.excludePatterns.map(toPosixPath),
    useDirents: !options.stats && !options.followSymbolicLinks,
    suppressErrors: options.suppressErrors ?? false,
    respectGitignore: options.respectGitignore ?? false,
  };

  if (options.maxDepth !== undefined) {
    normalized.maxDepth = options.maxDepth;
  }

  return normalized;
}

function getRelativeDepth(relativePath: string): number {
  const len = relativePath.length;
  if (len === 0) return 0;
  let count = 0;
  for (let i = 0; i < len; i++) {
    const code = relativePath.charCodeAt(i);
    if (code === 47 || code === 92) {
      count++;
    }
  }
  return count + 1;
}

function resolveDirentBase(cwd: string, parentPath: string | undefined): string {
  if (!parentPath) return cwd;
  return isAbsolute(parentPath) ? parentPath : resolve(cwd, parentPath);
}

function resolveStringMatchPath(cwd: string, match: string): string {
  return isAbsolute(match) ? match : resolve(cwd, match);
}

function* processDirentMatch(
  match: GlobDirentLike,
  cwd: string,
  maxDepth: number | undefined,
  seen: Set<string>,
  onlyFiles: boolean,
): Generator<GlobEntry> {
  const base = resolveDirentBase(cwd, match.parentPath);
  const absolutePath = resolve(base, match.name);

  if (maxDepth !== undefined) {
    const rel = relative(cwd, absolutePath);
    if (getRelativeDepth(rel) > maxDepth) return;
  }

  if (seen.has(absolutePath)) return;
  seen.add(absolutePath);

  if (onlyFiles && !match.isFile()) return;
  yield { path: absolutePath, dirent: match };
}

async function resolveStringMatch(
  match: string,
  cwd: string,
  maxDepth: number | undefined,
  seen: Set<string>,
  onlyFiles: boolean,
  followSymlinks: boolean,
  returnStats: boolean,
  suppressErrors: boolean,
): Promise<GlobEntry | null> {
  if (maxDepth !== undefined) {
    const depth = getRelativeDepth(match);
    if (depth > maxDepth) return null;
  }

  const absolutePath = resolveStringMatchPath(cwd, match);

  if (seen.has(absolutePath)) return null;
  seen.add(absolutePath);

  try {
    const stats = followSymlinks ? await fsStat(absolutePath) : await fsLstat(absolutePath);

    if (onlyFiles && !stats.isFile()) return null;

    const entry: GlobEntry = { path: absolutePath, dirent: stats };
    if (!isAbsolute(match)) {
      entry.relativePath = match;
    }
    if (returnStats) entry.stats = stats;
    return entry;
  } catch (error) {
    if (!suppressErrors) throw error;
    return null;
  }
}

interface ProcessContext {
  cwd: string;
  maxDepth: number | undefined;
  seen: Set<string>;
  onlyFiles: boolean;
  followSymlinks: boolean;
  returnStats: boolean;
  suppressErrors: boolean;
}

class AsyncGlobBatchQueue {
  private buffer: string[];
  private bufferLength = 0;
  private readonly context: ProcessContext;

  constructor(context: ProcessContext) {
    this.context = context;
    this.buffer = new Array<string>(GLOB_BATCH_CONCURRENCY);
  }

  add(match: string): void {
    this.buffer[this.bufferLength++] = match;
  }

  isFull(): boolean {
    return this.bufferLength >= GLOB_BATCH_CONCURRENCY;
  }

  hasItems(): boolean {
    return this.bufferLength > 0;
  }

  async *flush(): AsyncGenerator<GlobEntry> {
    if (this.bufferLength === 0) return;

    const count = this.bufferLength;
    this.bufferLength = 0;

    const promises = new Array<Promise<GlobEntry | null>>(count);
    for (let i = 0; i < count; i++) {
      const matchPath = this.buffer[i];
      promises[i] = resolveStringMatch(
        matchPath ?? '',
        this.context.cwd,
        this.context.maxDepth,
        this.context.seen,
        this.context.onlyFiles,
        this.context.followSymlinks,
        this.context.returnStats,
        this.context.suppressErrors,
      );
    }

    const results = await Promise.all(promises);

    for (let i = 0; i < count; i++) {
      const entry = results[i];
      if (entry !== null && entry !== undefined) yield entry;
    }
  }
}

function createExcludeFilter(
  cwd: string,
  excludePatterns: readonly string[],
  gitignoreMatcher?: Ignore | null,
): ((match: GlobMatch) => boolean) | readonly string[] {
  if (!gitignoreMatcher) {
    return excludePatterns;
  }

  return (match: GlobMatch) => {
    const relPath =
      typeof match === 'string'
        ? match
        : match.parentPath
          ? relative(cwd, join(match.parentPath, match.name))
          : match.name;

    const posixRel = toPosixPath(relPath);

    // Gitignore check
    const isDir = typeof match === 'string' ? false : match.isDirectory();
    if (
      isIgnoredByGitignore(gitignoreMatcher, cwd, '', {
        relativePath: posixRel,
        isDirectory: isDir,
      })
    ) {
      return true;
    }

    // Also check explicit exclude patterns
    if (excludePatterns.length > 0) {
      for (const ex of excludePatterns) {
        if (posix.matchesGlob(posixRel, ex)) return true;
      }
    }

    return false;
  };
}

async function* nativeGlobEntries(
  options: GlobEntriesOptions,
  gitignoreMatcher?: Ignore | null,
): AsyncGenerator<GlobEntry> {
  const plan = normalizeGlobOptions(options);
  const seen = new Set<string>();

  const { cwd, maxDepth, suppressErrors } = plan;
  const { onlyFiles, stats: returnStats, followSymbolicLinks: followSymlinks } = options;

  const context = {
    cwd,
    maxDepth,
    seen,
    onlyFiles,
    followSymlinks,
    returnStats,
    suppressErrors,
  };

  const forceFileTypes = plan.useDirents || Boolean(gitignoreMatcher);
  const excludeFunc = createExcludeFilter(cwd, plan.exclude, gitignoreMatcher);

  for (const pattern of plan.patterns) {
    let iterable: AsyncIterable<GlobMatch>;
    try {
      iterable = fsGlob(pattern, {
        cwd,
        exclude: excludeFunc,
        withFileTypes: forceFileTypes,
      }) as AsyncIterable<GlobMatch>;
    } catch (error) {
      if (suppressErrors) continue;
      throw error;
    }

    if (plan.useDirents) {
      try {
        for await (const match of iterable) {
          yield* processDirentMatch(
            match as GlobDirentLike,
            context.cwd,
            context.maxDepth,
            context.seen,
            context.onlyFiles,
          );
        }
      } catch (error) {
        if (!suppressErrors) throw error;
      }
    } else {
      const queue = new AsyncGlobBatchQueue(context);
      try {
        for await (const match of iterable) {
          let strMatch: string;
          if (typeof match === 'string') {
            strMatch = match;
          } else {
            strMatch = match.parentPath
              ? relative(cwd, join(match.parentPath, match.name))
              : match.name;
          }
          queue.add(strMatch);
          if (queue.isFull()) {
            yield* queue.flush();
          }
        }
        yield* queue.flush();
      } catch (error) {
        if (!suppressErrors) throw error;
      }
    }
  }
}

export async function* globEntries(options: GlobEntriesOptions): AsyncGenerator<GlobEntry> {
  const engine = 'node:fs/promises.glob';
  const endMeasure = startPerfMeasure('globEntries', { engine });

  let ok = false;
  try {
    yield* withOpsTrace({ op: 'globEntries', engine }, async function* () {
      let gitignoreMatcher: Ignore | null = null;
      if (options.respectGitignore) {
        gitignoreMatcher = await loadRootGitignore(options.cwd);
      }
      assertOptionsShape(options);
      yield* nativeGlobEntries(options, gitignoreMatcher);
    });
    ok = true;
  } finally {
    endMeasure?.(ok);
  }
}

interface GlobConfig {
  cwd: string;
  pattern: string;
  excludePatterns?: readonly string[];
  includeHidden?: boolean;
  baseNameMatch?: boolean;
  caseSensitiveMatch?: boolean;
  followSymbolicLinks?: boolean;
  onlyFiles?: boolean;
  stats?: boolean;
  maxDepth?: number;
  suppressErrors?: boolean;
  respectGitignore?: boolean;
}

export function buildGlobOptions(config: GlobConfig): Parameters<typeof globEntries>[0] {
  const options: Parameters<typeof globEntries>[0] = {
    cwd: config.cwd,
    pattern: config.pattern,
    excludePatterns: config.excludePatterns ?? [],
    includeHidden: config.includeHidden ?? false,
    baseNameMatch: config.baseNameMatch ?? false,
    caseSensitiveMatch: config.caseSensitiveMatch ?? true,
    followSymbolicLinks: config.followSymbolicLinks ?? false,
    onlyFiles: config.onlyFiles ?? true,
    stats: config.stats ?? false,
  };

  if (config.suppressErrors) {
    options.suppressErrors = config.suppressErrors;
  }

  if (config.maxDepth !== undefined) {
    options.maxDepth = config.maxDepth;
  }

  if (config.respectGitignore !== undefined) {
    options.respectGitignore = config.respectGitignore;
  }

  return options;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type MimeKind = 'text' | 'binary' | 'image' | 'audio' | 'pdf';

export interface MimeInfo {
  mimeType: string;
  kind: MimeKind;
}

// ─── Extension Map ──────────────────────────────────────────────────────────
// Maps file extensions to MIME types (80+ common extensions)

const EXT_MAP: Record<string, { mimeType: string; kind: MimeKind }> = {
  // Text: Web & Markup
  html: { mimeType: 'text/html', kind: 'text' },
  htm: { mimeType: 'text/html', kind: 'text' },
  xml: { mimeType: 'text/xml', kind: 'text' },
  css: { mimeType: 'text/css', kind: 'text' },
  svg: { mimeType: 'image/svg+xml', kind: 'image' },
  md: { mimeType: 'text/markdown', kind: 'text' },
  markdown: { mimeType: 'text/markdown', kind: 'text' },
  mdown: { mimeType: 'text/markdown', kind: 'text' },

  // Text: Programming Languages
  js: { mimeType: 'text/javascript', kind: 'text' },
  mjs: { mimeType: 'text/javascript', kind: 'text' },
  jsx: { mimeType: 'text/jsx', kind: 'text' },
  ts: { mimeType: 'text/typescript', kind: 'text' },
  tsx: { mimeType: 'text/tsx', kind: 'text' },
  py: { mimeType: 'text/x-python', kind: 'text' },
  java: { mimeType: 'text/x-java', kind: 'text' },
  c: { mimeType: 'text/x-c', kind: 'text' },
  cpp: { mimeType: 'text/x-cpp', kind: 'text' },
  cc: { mimeType: 'text/x-cpp', kind: 'text' },
  cxx: { mimeType: 'text/x-cpp', kind: 'text' },
  h: { mimeType: 'text/x-c', kind: 'text' },
  hpp: { mimeType: 'text/x-cpp', kind: 'text' },
  go: { mimeType: 'text/x-go', kind: 'text' },
  rs: { mimeType: 'text/x-rust', kind: 'text' },
  rb: { mimeType: 'text/x-ruby', kind: 'text' },
  php: { mimeType: 'text/x-php', kind: 'text' },
  sh: { mimeType: 'text/x-shellscript', kind: 'text' },
  bash: { mimeType: 'text/x-shellscript', kind: 'text' },
  zsh: { mimeType: 'text/x-shellscript', kind: 'text' },
  ps1: { mimeType: 'text/x-powershell', kind: 'text' },
  sql: { mimeType: 'text/x-sql', kind: 'text' },

  // Text: Data formats
  json: { mimeType: 'application/json', kind: 'text' },
  jsonc: { mimeType: 'application/json', kind: 'text' },
  ndjson: { mimeType: 'application/x-ndjson', kind: 'text' },
  yaml: { mimeType: 'text/yaml', kind: 'text' },
  yml: { mimeType: 'text/yaml', kind: 'text' },
  toml: { mimeType: 'text/toml', kind: 'text' },
  ini: { mimeType: 'text/plain', kind: 'text' },
  cfg: { mimeType: 'text/plain', kind: 'text' },
  conf: { mimeType: 'text/plain', kind: 'text' },
  csv: { mimeType: 'text/csv', kind: 'text' },

  // Text: Diff & Patches
  diff: { mimeType: 'text/x-diff', kind: 'text' },
  patch: { mimeType: 'text/x-diff', kind: 'text' },

  // Text: Documentation
  txt: { mimeType: 'text/plain', kind: 'text' },
  text: { mimeType: 'text/plain', kind: 'text' },
  log: { mimeType: 'text/plain', kind: 'text' },
  rst: { mimeType: 'text/x-rst', kind: 'text' },

  // Image formats
  png: { mimeType: 'image/png', kind: 'image' },
  jpg: { mimeType: 'image/jpeg', kind: 'image' },
  jpeg: { mimeType: 'image/jpeg', kind: 'image' },
  gif: { mimeType: 'image/gif', kind: 'image' },
  webp: { mimeType: 'image/webp', kind: 'image' },
  ico: { mimeType: 'image/x-icon', kind: 'image' },
  bmp: { mimeType: 'image/bmp', kind: 'image' },
  tiff: { mimeType: 'image/tiff', kind: 'image' },
  tif: { mimeType: 'image/tiff', kind: 'image' },

  // Audio formats
  mp3: { mimeType: 'audio/mpeg', kind: 'audio' },
  wav: { mimeType: 'audio/wav', kind: 'audio' },
  flac: { mimeType: 'audio/flac', kind: 'audio' },
  aac: { mimeType: 'audio/aac', kind: 'audio' },
  ogg: { mimeType: 'audio/ogg', kind: 'audio' },
  m4a: { mimeType: 'audio/mp4', kind: 'audio' },

  // PDF
  pdf: { mimeType: 'application/pdf', kind: 'pdf' },

  // Archives
  zip: { mimeType: 'application/zip', kind: 'binary' },
  tar: { mimeType: 'application/x-tar', kind: 'binary' },
  gz: { mimeType: 'application/gzip', kind: 'binary' },
  gzip: { mimeType: 'application/gzip', kind: 'binary' },
  '7z': { mimeType: 'application/x-7z-compressed', kind: 'binary' },
  rar: { mimeType: 'application/x-rar-compressed', kind: 'binary' },
  bz2: { mimeType: 'application/x-bzip2', kind: 'binary' },
  xz: { mimeType: 'application/x-xz', kind: 'binary' },

  // Other binary formats
  wasm: { mimeType: 'application/wasm', kind: 'binary' },
  so: { mimeType: 'application/octet-stream', kind: 'binary' },
  dylib: { mimeType: 'application/octet-stream', kind: 'binary' },
  dll: { mimeType: 'application/octet-stream', kind: 'binary' },
  exe: { mimeType: 'application/octet-stream', kind: 'binary' },
  msi: { mimeType: 'application/octet-stream', kind: 'binary' },
  dmg: { mimeType: 'application/octet-stream', kind: 'binary' },
};

// ─── Magic Signatures ────────────────────────────────────────────────────────
// Detect file types by magic bytes (file signatures)

interface MagicSignature {
  bytes: Buffer;
  offset: number;
  mimeType: string;
  kind: MimeKind;
}

const MAGIC_SIGNATURES: MagicSignature[] = [
  // PNG
  {
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    offset: 0,
    mimeType: 'image/png',
    kind: 'image',
  },
  // JPEG
  {
    bytes: Buffer.from([0xff, 0xd8, 0xff]),
    offset: 0,
    mimeType: 'image/jpeg',
    kind: 'image',
  },
  // GIF 87a and 89a
  {
    bytes: Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]),
    offset: 0,
    mimeType: 'image/gif',
    kind: 'image',
  },
  {
    bytes: Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
    offset: 0,
    mimeType: 'image/gif',
    kind: 'image',
  },
  // WEBP
  {
    bytes: Buffer.from([0x52, 0x49, 0x46, 0x46]),
    offset: 0,
    mimeType: 'image/webp',
    kind: 'image',
  }, // RIFF header, webp check is more complex
  // PDF
  {
    bytes: Buffer.from([0x25, 0x50, 0x44, 0x46]),
    offset: 0,
    mimeType: 'application/pdf',
    kind: 'pdf',
  }, // %PDF
  // ZIP
  {
    bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    offset: 0,
    mimeType: 'application/zip',
    kind: 'binary',
  }, // PK..
  {
    bytes: Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    offset: 0,
    mimeType: 'application/zip',
    kind: 'binary',
  }, // PK..
  {
    bytes: Buffer.from([0x50, 0x4b, 0x07, 0x08]),
    offset: 0,
    mimeType: 'application/zip',
    kind: 'binary',
  }, // PK..
  // TAR (gzip compressed)
  {
    bytes: Buffer.from([0x1f, 0x8b]),
    offset: 0,
    mimeType: 'application/gzip',
    kind: 'binary',
  },
];

// ─── Helper Functions ───────────────────────────────────────────────────────

export const MIME_SAMPLE_SIZE = 512;

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, MIME_SAMPLE_SIZE);
  if (sample.length === 0) return true;

  // Count non-text bytes
  let nonTextCount = 0;
  for (const byte of sample) {
    // Allow common control characters (9=tab, 10=LF, 13=CR) and printable ASCII (32-126) + extended ASCII
    if (byte < 9 || (byte > 13 && byte < 32 && byte !== 27) || (byte > 126 && byte < 160)) {
      nonTextCount++;
    }
  }

  // If less than 30% non-text bytes, consider it text
  return nonTextCount / sample.length < 0.3;
}

/**
 * Detect MIME type by checking magic signatures in buffer.
 */
const WEBP_MARKER_BYTES = Buffer.from([0x57, 0x45, 0x42, 0x50]);

function detectByMagic(buffer: Buffer): MimeInfo | null {
  for (const sig of MAGIC_SIGNATURES) {
    const end = sig.offset + sig.bytes.length;
    if (buffer.length >= end) {
      if (buffer.compare(sig.bytes, 0, sig.bytes.length, sig.offset, end) === 0) {
        // Special handling for RIFF (WEBP vs AVI)
        if (sig.mimeType === 'image/webp') {
          if (buffer.length >= 12 && buffer.compare(WEBP_MARKER_BYTES, 0, 4, 8, 12) === 0) {
            return { mimeType: 'image/webp', kind: 'image' };
          }
          continue;
        }
        return { mimeType: sig.mimeType, kind: sig.kind };
      }
    }
  }
  return null;
}

// ─── Main Function ──────────────────────────────────────────────────────────

/**
 * Detect MIME type from file path and optional buffer sample.
 * Prioritizes extension, then magic bytes, then text/binary heuristics.
 *
 * @param path - File path or name
 * @param sample - Optional buffer sample from file (first 512+ bytes recommended)
 * @returns Object with mimeType string and kind classification
 */
export function detectMimeType(path: string, sample?: Buffer): MimeInfo {
  // Extract extension (lowercase, no dot)
  const lastDot = path.lastIndexOf('.');
  const ext = lastDot > -1 ? path.slice(lastDot + 1).toLowerCase() : '';

  // 1. Check extension map
  if (ext && Object.hasOwn(EXT_MAP, ext)) {
    const entry = EXT_MAP[ext];
    if (entry !== undefined) {
      return entry;
    }
  }

  // 2. Check magic signatures then text heuristics if sample provided
  if (sample) {
    if (sample.length > 0) {
      const magicResult = detectByMagic(sample);
      if (magicResult !== null) return magicResult;
    }
    return looksLikeText(sample)
      ? { mimeType: 'text/plain', kind: 'text' }
      : { mimeType: 'application/octet-stream', kind: 'binary' };
  }

  // 3. Final fallback
  return { mimeType: 'application/octet-stream', kind: 'binary' };
}

export const DEFAULT_EXCLUDE_PATTERNS = [
  '**/node_modules',
  '**/node_modules/**',
  '**/dist',
  '**/dist/**',
  '**/build',
  '**/build/**',
  '**/coverage',
  '**/coverage/**',
  '**/.git',
  '**/.git/**',
  '**/.vscode',
  '**/.vscode/**',
  '**/.idea',
  '**/.idea/**',
  '**/.DS_Store',
  '**/.next',
  '**/.next/**',
  '**/.nuxt',
  '**/.nuxt/**',
  '**/.output',
  '**/.output/**',
  '**/.svelte-kit',
  '**/.svelte-kit/**',
  '**/.cache',
  '**/.cache/**',
  '**/.yarn',
  '**/.yarn/**',
  '**/jspm_packages',
  '**/jspm_packages/**',
  '**/bower_components',
  '**/bower_components/**',
  '**/out',
  '**/out/**',
  '**/tmp',
  '**/tmp/**',
  '**/.temp',
  '**/.temp/**',
  '**/npm-debug.log',
  '**/yarn-debug.log',
  '**/yarn-error.log',
  '**/Thumbs.db',
];

// ─── GuardedFileSystem Facade ──────────────────────────────────────────────────

/**
 * A facade over file system operations that automatically validates all paths
 * against the provided PathGuard. This deepens the file system module by
 * encapsulating path validation, so callers do not need to thread PathGuard
 * into every individual function call.
 */
export class GuardedFileSystem {
  readonly pathGuard: PathGuard;

  constructor(pathGuard: PathGuard) {
    this.pathGuard = pathGuard;
  }

  async stat(filePath: string, options?: { signal?: AbortSignal }) {
    return stat(filePath, this.pathGuard, options);
  }

  async lstat(filePath: string, options?: { signal?: AbortSignal }) {
    return lstat(filePath, this.pathGuard, options);
  }

  async mkdir(filePath: string, options?: Parameters<typeof fsMkdir>[1]) {
    return mkdir(filePath, this.pathGuard, options);
  }

  async rename(oldPath: string, newPath: string) {
    return rename(oldPath, newPath, this.pathGuard);
  }

  async rm(filePath: string, options?: Parameters<typeof fsRm>[1]) {
    return rm(filePath, this.pathGuard, options);
  }

  async rmdir(filePath: string, options?: Parameters<typeof fsRmdir>[1]) {
    return rmdir(filePath, this.pathGuard, options);
  }

  async readlink(filePath: string, options?: Parameters<typeof fsReadlink>[1]) {
    return readlink(filePath, this.pathGuard, options);
  }

  async cp(source: string, destination: string, options?: Parameters<typeof fsCp>[2]) {
    return cp(source, destination, this.pathGuard, options);
  }

  async isProbablyBinary(filePath: string, existingHandle?: FileHandle, signal?: AbortSignal) {
    return isProbablyBinary(filePath, existingHandle, signal);
  }

  async hash(filePath: string, signal?: AbortSignal) {
    return calculateFileContentHash(filePath, signal, 'hex' as const);
  }

  async calculateFileContentHash(
    filePath: string,
    signal?: AbortSignal,
    encoding?: BinaryToTextEncoding | null,
  ): Promise<string | Buffer> {
    if (encoding === null) {
      return calculateFileContentHash(filePath, signal, null);
    }
    if (encoding === undefined) {
      return calculateFileContentHash(filePath, signal);
    }
    return calculateFileContentHash(filePath, signal, encoding);
  }

  async readFileRaw(filePath: string, options?: { signal?: AbortSignal }) {
    return readFileRaw(filePath, this.pathGuard, options);
  }

  async readFileWithStats(
    filePath: string,
    validPath: string,
    stats: Stats,
    spec: ReadSpec | undefined,
  ) {
    return readFileWithStats(filePath, validPath, stats, spec);
  }

  async readFile(filePath: string, spec: ReadSpec) {
    return readFile(filePath, spec, this.pathGuard);
  }

  async atomicWriteFile(
    filePath: string,
    content: string,
    options?: { encoding?: BufferEncoding; signal?: AbortSignal | undefined },
  ) {
    return atomicWriteFile(filePath, content, this.pathGuard, options);
  }
}
