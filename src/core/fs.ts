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
import { text } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';

import { assertNotAborted, withAbort } from './concurrency.js';
import { ErrorCode, formatUnknownErrorMessage, FsError, isFsError, isNodeError } from './errors.js';
import {
  detectMimeFromContent,
  isBinarySample,
  isKnownBinaryExtension,
  MIME_SAMPLE_SIZE,
} from './mime.js';
import { Logger } from './observability.js';
import type { PathGuard } from './path.js';
import type { EntryType as FileType } from './primitives.js';
import { MAX_TEXT_FILE_SIZE } from './util.js';

export type { FileType };
export type { Stats, ReadStream };
export type { FileHandle };

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

async function stat(
  filePath: string,
  pathGuard: PathGuard,
  options?: { signal?: AbortSignal },
): Promise<{ stats: Stats; validPath: string }> {
  const validPath = await pathGuard.validateExistingPath(filePath);
  const stats = await withAbort(fsStat(validPath), options?.signal);
  return { stats, validPath };
}

async function mkdir(
  filePath: string,
  pathGuard: PathGuard,
  options?: Parameters<typeof fsMkdir>[1],
): Promise<{ validPath: string; result: string | undefined }> {
  const validPath = await pathGuard.validatePathForWrite(filePath);
  const result = await fsMkdir(validPath, options);
  return { validPath, result };
}

async function readlink(
  filePath: string,
  pathGuard: PathGuard,
  options?: Parameters<typeof fsReadlink>[1],
): Promise<{ linkString: string; validPath: string }> {
  // validateExistingPath resolves through the symlink, so readlink would always
  // be handed the final target — a regular file — and fail EINVAL. This guard
  // keeps the link itself while still enforcing containment and the denylist.
  const validPath = await pathGuard.validatePathForDelete(filePath);
  const raw = await fsReadlink(validPath, options);
  const linkString = Buffer.isBuffer(raw) ? raw.toString('utf-8') : raw;
  return { linkString, validPath };
}

// ─── Input validation ────────────────────────────────────────────────────────

function assertPositiveIntegerOption(name: string, value: unknown, message?: string): void {
  if (
    value === undefined ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1)
  )
    return;
  throw new FsError(ErrorCode.INVALID_INPUT, message ?? `${name} must be a positive integer`);
}

async function openReadableFileHandle(filePath: string, signal?: AbortSignal): Promise<FileHandle> {
  const handlePromise = fsOpen(filePath, READ_ONLY_FILE_FLAG);
  if (!signal) return handlePromise;
  try {
    return await withAbort(handlePromise, signal);
  } catch (error) {
    void handlePromise
      .then((handle) => {
        void handle.close().catch((closeErr: unknown) => {
          Logger.warn(
            `Failed to close file handle for ${filePath} after abort: ${formatUnknownErrorMessage(closeErr)}`,
          );
        });
      })
      .catch(() => {
        /* ignore open error */
      });
    throw error;
  }
}

async function readProbe(handle: FileHandle, signal?: AbortSignal): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MIME_SAMPLE_SIZE);
  const { bytesRead } = await withAbort(handle.read(buffer, 0, MIME_SAMPLE_SIZE, 0), signal);

  if (bytesRead === 0) {
    return Buffer.alloc(0);
  }

  return buffer.subarray(0, bytesRead);
}

async function isProbablyBinary(
  filePath: string,
  existingHandle?: FileHandle,
  signal?: AbortSignal,
): Promise<boolean> {
  if (isKnownBinaryExtension(filePath)) {
    return true;
  }

  if (existingHandle) {
    const slice = await readProbe(existingHandle, signal);
    return isBinarySample(slice);
  }

  await using handle = await openReadableFileHandle(filePath, signal);
  const slice = await readProbe(handle, signal);
  return isBinarySample(slice);
}

// ─── File hashing ────────────────────────────────────────────────────────────

async function calculateFileContentHash(filePath: string, signal?: AbortSignal): Promise<string> {
  const hasher = createHash('sha256');
  await pipeline(createReadStream(filePath, { signal, highWaterMark: STREAM_CHUNK_SIZE }), hasher, {
    signal,
  });
  return hasher.digest('hex');
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

interface NormalizeResult {
  normalized: NormalizedOptions;
  mode: ReadMode;
}

function buildBaseOptions(spec: ReadSpec): NormalizedOptions {
  if (spec.maxSize !== undefined) {
    assertPositiveIntegerOption('maxSize', spec.maxSize, 'maxSize must be at least 1');
  }
  return {
    encoding: spec.encoding ?? 'utf-8',
    maxSize: Math.min(spec.maxSize ?? MAX_TEXT_FILE_SIZE, MAX_TEXT_FILE_SIZE),
    skipBinary: spec.skipBinary ?? false,
    ...(spec.signal ? { signal: spec.signal } : {}),
  };
}

function normalizeHeadSpec(
  spec: Extract<ReadSpec, { kind: 'head' }>,
  base: NormalizedOptions,
): NormalizeResult {
  assertPositiveIntegerOption('lines', spec.lines, 'lines must be at least 1');
  return { normalized: { ...base, head: spec.lines }, mode: 'head' };
}

function normalizeTailSpec(
  spec: Extract<ReadSpec, { kind: 'tail' }>,
  base: NormalizedOptions,
): NormalizeResult {
  assertPositiveIntegerOption('lines', spec.lines, 'lines must be at least 1');
  return { normalized: { ...base, tail: spec.lines }, mode: 'tail' };
}

function normalizeRangeSpec(
  spec: Extract<ReadSpec, { kind: 'range' }>,
  base: NormalizedOptions,
): NormalizeResult {
  assertPositiveIntegerOption('start', spec.start, 'start must be at least 1');
  if (spec.end !== undefined) {
    assertPositiveIntegerOption('end', spec.end, 'end must be at least 1');
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

function normalizeByteRangeSpec(
  spec: Extract<ReadSpec, { kind: 'byteRange' }>,
  base: NormalizedOptions,
): NormalizeResult {
  if (spec.offset !== undefined && !(Number.isSafeInteger(spec.offset) && spec.offset >= 0)) {
    throw new FsError(ErrorCode.INVALID_INPUT, 'offset must be a non-negative integer');
  }
  assertPositiveIntegerOption('length', spec.length);
  return {
    normalized: {
      ...base,
      ...(spec.offset !== undefined ? { offset: spec.offset } : {}),
      ...(spec.length !== undefined ? { length: spec.length } : {}),
    },
    mode: 'byteRange',
  };
}

function normalizeSpec(spec: ReadSpec): NormalizeResult {
  const base = buildBaseOptions(spec);
  assertNotAborted(spec.signal);

  switch (spec.kind) {
    case 'head':
      return normalizeHeadSpec(spec, base);
    case 'tail':
      return normalizeTailSpec(spec, base);
    case 'range':
      return normalizeRangeSpec(spec, base);
    case 'byteRange':
      return normalizeByteRangeSpec(spec, base);
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
      stream.on('error', (_err: unknown) => {
        /* suppress post-destroy error event */
      });
      stream.destroy();
    }
  }

  return Buffer.concat(chunks, totalSize);
}

export function countLines(content: string): number {
  // Matches `content.split('\n').length`: an empty file is one (empty) line,
  // not zero. create/edit/replace report lineCount and their contract locks 1
  // for empty content; read's totalLines shares this single source.
  let count = 1;
  let pos = content.indexOf('\n');
  while (pos !== -1) {
    count++;
    pos = content.indexOf('\n', pos + 1);
  }
  return count;
}

async function peekHasMore(iterator: AsyncIterator<string>): Promise<boolean> {
  try {
    const { done } = await iterator.next();
    return !done;
  } catch (error) {
    // The peek only asks "is there another line", and the caller keeps nothing
    // it returns. An over-long line past the requested range still answers yes
    // — failing the whole read over a line outside it would reject e.g. lines
    // 1-2 of a file whose line 3 is one 50 KB blob.
    if (isFsError(error) && error.code === ErrorCode.TOO_LARGE) return true;
    throw error;
  }
}

const LF = 0x0a;

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Line iterator bounded by bytes rather than by the decoded string, so a file
 * that is one enormous line cannot be materialized before the size check runs.
 * `handle.readLines` decodes the whole line first and can OOM on such a file.
 *
 * Yields lines from `startLine` onward, 1-indexed. Lines before `startLine` are
 * counted and discarded without accumulating, so an over-long line the caller
 * skipped past does not fail the read. Line endings match `readLines`: split on
 * `\n`, with a preceding `\r` stripped, so CRLF input decodes identically.
 */
async function* readLinesBounded(
  handle: FileHandle,
  options: ReadContentOptions,
  filePath: string,
  startLine: number,
): AsyncGenerator<string, void, undefined> {
  const stream = handle.createReadStream({
    start: 0,
    highWaterMark: STREAM_CHUNK_SIZE,
    autoClose: false,
    emitClose: false,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const decoder = new StringDecoder(options.encoding);
  let pending = '';
  let pendingBytes = 0;
  let lineNumber = 0;

  const tooLong = (bytes: number): FsError =>
    new FsError(
      ErrorCode.TOO_LARGE,
      `File too large (single line ${bytes} > ${options.maxSize} bytes). Use a narrower range or head.`,
      filePath,
      { size: bytes, maxSize: options.maxSize },
    );

  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      let offset = 0;

      for (let nl = buffer.indexOf(LF, offset); nl !== -1; nl = buffer.indexOf(LF, offset)) {
        const segment = buffer.subarray(offset, nl);
        const lineBytes = pendingBytes + segment.length;
        lineNumber++;
        // Decode even when skipping: the decoder carries multi-byte
        // continuation state into the first line the caller keeps.
        const decoded = decoder.write(segment);
        if (lineNumber >= startLine) {
          if (lineBytes > options.maxSize) throw tooLong(lineBytes);
          yield stripCarriageReturn(pending + decoded);
        }
        pending = '';
        pendingBytes = 0;
        offset = nl + 1;
      }

      const rest = buffer.subarray(offset);
      pendingBytes += rest.length;
      if (lineNumber + 1 < startLine) {
        decoder.write(rest); // still skipping; drop the text, keep decoder state
      } else {
        if (pendingBytes > options.maxSize) throw tooLong(pendingBytes);
        pending += decoder.write(rest);
      }
    }

    // Trailing line with no final newline. A file ending in `\n` leaves
    // pendingBytes at 0 and emits nothing, matching readLines.
    if (pendingBytes > 0) {
      lineNumber++;
      if (lineNumber >= startLine) {
        if (pendingBytes > options.maxSize) throw tooLong(pendingBytes);
        yield pending + decoder.end();
      }
    }
  } finally {
    if (!stream.destroyed) {
      stream.on('error', (_err: unknown) => {
        /* suppress post-destroy error event */
      });
      stream.destroy();
    }
  }
}

async function readRangeContent(
  handle: FileHandle,
  startLine: number,
  endLine: number | undefined,
  options: ReadContentOptions,
  filePath: string,
): Promise<PartialReadResult> {
  assertNotAborted(options.signal);

  const lines: string[] = [];
  let lineNumber = startLine - 1;
  let estimatedBytes = 0;
  const newlineBytes = Buffer.byteLength('\n', options.encoding);
  const stopAt = endLine ?? Number.POSITIVE_INFINITY;

  let hasMoreLines = false;
  let stoppedByLimit = false;

  // Byte-bounded: an over-long line throws TOO_LARGE while still a partial
  // buffer, before it can be decoded into one huge string.
  const iterator = readLinesBounded(handle, options, filePath, startLine)[Symbol.asyncIterator]();

  try {
    for (;;) {
      const { value: line, done } = await iterator.next();
      if (done) {
        break;
      }
      lineNumber++;

      if (lineNumber > stopAt) {
        hasMoreLines = true;
        break;
      }

      lines.push(line);

      estimatedBytes += Buffer.byteLength(line, options.encoding) + newlineBytes;
      if (estimatedBytes > options.maxSize) {
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
    await iterator.return();
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
  filePath: string,
): Promise<PartialReadResult> {
  assertNotAborted(options.signal);

  const stats = await handle.stat();
  const fileSize = stats.size;
  if (fileSize === 0) {
    return {
      content: '',
      truncated: false,
      linesRead: 0,
      hasMoreLines: false,
    };
  }

  const encoding = options.encoding;
  // Accumulate raw bytes from the end rather than decoding each chunk
  // independently: decoding a chunk that ends mid-codepoint corrupts the
  // trailing multi-byte UTF-8 sequence into U+FFFD. 0x0A (newline) is a single
  // byte and never part of a multibyte sequence, so counting newlines on the
  // raw buffer is safe; we decode the whole bounded buffer once at the end.
  let position = fileSize;
  const chunks: Buffer[] = [];
  let totalLen = 0;
  let newlines = 0;
  let stoppedByLimit = false;

  while (position > 0) {
    assertNotAborted(options.signal);
    const chunkSize = Math.min(position, STREAM_CHUNK_SIZE);
    const buffer = Buffer.allocUnsafe(chunkSize);
    const { bytesRead } = await handle.read(buffer, 0, chunkSize, position - chunkSize);
    if (bytesRead < chunkSize) {
      // The file shrank under us. Bytes from `position` on are still a
      // contiguous suffix, so keep those and stop — splicing this short chunk in
      // would leave a hole (and, with an alloc'd buffer, NULs) mid-content.
      // `position` stays put, so the result is reported as having more lines.
      break;
    }
    position -= chunkSize;

    for (const byte of buffer) {
      if (byte === 0x0a) newlines++;
    }

    chunks.unshift(buffer);
    totalLen += chunkSize;

    // One newline more than `tail`: the oldest segment in the buffer starts
    // mid-line whenever we stop before the file start, and gets dropped below.
    if (newlines > tail) break;
    if (totalLen > options.maxSize) {
      stoppedByLimit = true;
      break;
    }
  }

  const allBytes = Buffer.concat(chunks, totalLen);
  let lines = allBytes.toString(encoding).split('\n');

  // A trailing newline produces a spurious empty final segment; drop it.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines = lines.slice(0, -1);
  }
  // Normalize CRLF.
  lines = lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));

  // We stopped before the file start, so the first segment is the tail of a
  // line whose beginning was never read. Drop it instead of reporting a
  // fragment as a complete line.
  if (position > 0 && lines.length > 0) {
    lines = lines.slice(1);
  }

  if (stoppedByLimit && lines.length < tail) {
    throw new FsError(
      ErrorCode.TOO_LARGE,
      `File too large (${totalLen} > ${options.maxSize} bytes, could not collect ${tail} lines). Use a narrower tail or head.`,
      filePath,
      { size: totalLen, maxSize: options.maxSize },
    );
  }

  let hasMoreLines = stoppedByLimit || position > 0;
  if (lines.length > tail) {
    hasMoreLines = true;
    lines = lines.slice(lines.length - tail);
  }

  const content = lines.join('\n');
  return {
    content,
    truncated: hasMoreLines,
    linesRead: lines.length,
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
    const contentOptions = buildReadContentOptions(this.context.normalized);
    const { content, truncated, linesRead, hasMoreLines } = await readRangeContent(
      this.context.handle,
      1,
      head,
      contentOptions,
      this.context.filePath,
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
    const contentOptions = buildReadContentOptions(this.context.normalized);
    const { content, truncated, linesRead, hasMoreLines } = await readRangeContent(
      this.context.handle,
      startLine,
      endLine,
      contentOptions,
      this.context.filePath,
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
    const contentOptions = buildReadContentOptions(this.context.normalized);
    const { content, truncated, linesRead, hasMoreLines } = await readTailContent(
      this.context.handle,
      tail,
      contentOptions,
      this.context.validPath,
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

async function readFileRaw(
  filePath: string,
  pathGuard: PathGuard,
  options?: { signal?: AbortSignal },
): Promise<{ content: Buffer; mimeType: string; isBinary: boolean }> {
  const validPath = await pathGuard.validateExistingPath(filePath);
  const stats = await withAbort(fsStat(validPath), options?.signal);
  assertFileStats(filePath, stats);
  // Enforce size limit before reading to avoid loading large files into memory.
  // Binary detection is best-effort, but this is a hard limit.
  if (stats.size > MAX_TEXT_FILE_SIZE) {
    throw createTooLargeError(stats.size, MAX_TEXT_FILE_SIZE, filePath);
  }
  const content = await withAbort(fsReadFile(validPath), options?.signal);
  const mimeInfo = detectMimeFromContent(validPath, content);
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
    assertNotAborted(signal);
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

  async stat(filePath: string, options?: { signal?: AbortSignal }) {
    return stat(filePath, this.pathGuard, options);
  }

  async lstat(filePath: string, options?: { signal?: AbortSignal }) {
    const validPath = await this.pathGuard.validatePathForDelete(filePath);
    const stats = await withAbort(fsLstat(validPath), options?.signal);
    return { stats, validPath };
  }

  async readlink(filePath: string, options?: Parameters<typeof fsReadlink>[1]) {
    return readlink(filePath, this.pathGuard, options);
  }

  async mkdir(filePath: string, options?: Parameters<typeof fsMkdir>[1]) {
    return mkdir(filePath, this.pathGuard, options);
  }

  async rename(oldPath: string, newPath: string) {
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
  ) {
    return atomicWriteFile(filePath, content, this.pathGuard, options);
  }

  async rm(filePath: string, options?: Parameters<typeof fsRm>[1]) {
    const validPath = await this.pathGuard.validatePathForDelete(filePath);
    await fsRm(validPath, options);
    return { validPath };
  }

  async rmdir(filePath: string, options?: Parameters<typeof fsRmdir>[1]) {
    const validPath = await this.pathGuard.validatePathForDelete(filePath);
    await fsRmdir(validPath, options);
    return { validPath };
  }

  async cp(source: string, destination: string, options?: Parameters<typeof fsCp>[2]) {
    // As in rename: keep the link itself so callers passing verbatimSymlinks
    // actually copy the link rather than a dereferenced target.
    const validSource = await this.pathGuard.validatePathForDelete(source);
    const validDest = await this.pathGuard.validatePathForWrite(destination);
    await fsCp(validSource, validDest, options);
    return { validSource, validDest };
  }

  async hash(filePath: string, signal?: AbortSignal) {
    // For hashing, we require the path to exist and be a file, so we use the stricter existing-path guard.
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    return calculateFileContentHash(validPath, signal);
  }

  async readFile(filePath: string, spec: ReadSpec) {
    const { normalized, mode } = normalizeSpec(spec);
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    assertNotAborted(normalized.signal);
    const stats = await withAbort(fsStat(validPath), normalized.signal);
    return readFileWithStatsInternal(filePath, validPath, stats, normalized, mode);
  }

  async readRaw(filePath: string, options?: { signal?: AbortSignal }) {
    return readFileRaw(filePath, this.pathGuard, options);
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

  async setRoots(resolvedRoots: readonly string[]): Promise<void> {
    await this.pathGuard.setRoots(resolvedRoots);
  }

  // ─── Validation pass-throughs ──────────────────────────────────────────────
  // One seam: tools call ctx.fs for everything, never ctx.pathGuard. These
  // delegate to the same PathGuard instance. `this.pathGuard` stays public for
  // the helpers that take a PathGuard as a parameter and cannot be expressed
  // as a method here — list.ts's collect and the two search engines. That is
  // the whole list; anything else belongs behind a method on this class.

  resolvePathOrRoot(pathValue: string | undefined): string {
    return this.pathGuard.resolvePathOrRoot(pathValue);
  }

  validateExistingPath(requestedPath: string) {
    return this.pathGuard.validateExistingPath(requestedPath);
  }

  validateExistingDirectory(requestedPath: string) {
    return this.pathGuard.validateExistingDirectory(requestedPath);
  }

  validatePathForWrite(requestedPath: string) {
    return this.pathGuard.validatePathForWrite(requestedPath);
  }

  validatePathForDelete(requestedPath: string) {
    return this.pathGuard.validatePathForDelete(requestedPath);
  }

  isAllowedRoot(normalizedPath: string): boolean {
    return this.pathGuard.isAllowedRoot(normalizedPath);
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
