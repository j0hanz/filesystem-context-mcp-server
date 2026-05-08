import { isUtf8 } from 'node:buffer';
import { type BinaryToTextEncoding, createHash, randomUUID } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import {
  type FileHandle,
  open,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { extname } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { FileType } from '../config.js';
import { assertNotAborted, withAbort } from './abort.js';
import {
  BINARY_CHECK_BUFFER_SIZE,
  KNOWN_BINARY_EXTENSIONS,
  MAX_TEXT_FILE_SIZE,
  PARALLEL_CONCURRENCY,
} from './constants.js';
import { ErrorCode, McpError, normalizeUnknownError } from './errors.js';
import { assertAllowedFileAccess, validateExistingPath } from './paths.js';

const READ_ONLY_FILE_FLAG = 'r';

const UNFILLED = Symbol('UNFILLED');
type Unfilled = typeof UNFILLED;

function assertPositiveSafeIntegerOption(
  name: string,
  value: unknown,
  message?: string
): void {
  if (value === undefined) return;

  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new McpError(
      ErrorCode.INVALID_INPUT,
      message ?? `${name} must be a positive integer`
    );
  }
}

function normalizeConcurrency(concurrency: number): number {
  assertPositiveSafeIntegerOption('concurrency', concurrency);
  return concurrency;
}

interface ParallelResult<R> {
  results: R[];
  errors: { index: number; error: Error }[];
}

function createParallelAbortError(): Error {
  return new DOMException('Operation aborted', 'AbortError');
}

export async function processInParallel<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number = PARALLEL_CONCURRENCY,
  signal?: AbortSignal
): Promise<ParallelResult<R>> {
  const itemCount = items.length;
  if (itemCount === 0) return { results: [], errors: [] };
  const effectiveConcurrency = normalizeConcurrency(concurrency);

  // Pre-allocate slots by index to guarantee input-order output.
  // Use UNFILLED sentinel to distinguish "not yet filled" from "filled with undefined".
  const resultSlots: (R | Unfilled)[] = new Array<R | Unfilled>(itemCount);
  const errors: { index: number; error: Error }[] = [];

  if (signal?.aborted) throw createParallelAbortError();

  let nextIndex = 0;

  resultSlots.fill(UNFILLED);

  const next = async (): Promise<void> => {
    while (nextIndex < itemCount) {
      if (signal?.aborted) throw createParallelAbortError();

      const index = nextIndex;
      nextIndex += 1;

      // Safe: `index < itemCount === items.length`, so `items[index]` is defined.
      // Cast bypasses `noUncheckedIndexedAccess` widening to `T | undefined`.
      const item = items[index] as T;

      try {
        const result = await processor(item);
        if (signal?.aborted) throw createParallelAbortError();
        resultSlots[index] = result;
      } catch (error) {
        if (signal?.aborted) throw createParallelAbortError();

        errors.push({
          index,
          error: normalizeUnknownError(error),
        });
      }
    }
  };

  const workerCount = Math.min(itemCount, effectiveConcurrency);
  const workers: Promise<void>[] = new Array<Promise<void>>(workerCount);
  for (let index = 0; index < workerCount; index += 1) {
    workers[index] = next();
  }

  await Promise.allSettled(workers);

  if (signal?.aborted) throw createParallelAbortError();

  const results: R[] = [];
  for (const slot of resultSlots) {
    if (slot !== UNFILLED) {
      results.push(slot);
    }
  }
  return { results, errors };
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

function hasKnownBinaryExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return KNOWN_BINARY_EXTENSIONS.has(ext);
}

async function openReadableFileHandle(
  filePath: string,
  signal?: AbortSignal
): Promise<FileHandle> {
  return withAbort(open(filePath, READ_ONLY_FILE_FLAG), signal);
}

async function readProbe(
  handle: FileHandle,
  signal?: AbortSignal
): Promise<Buffer> {
  const buffer = Buffer.alloc(BINARY_CHECK_BUFFER_SIZE);
  const { bytesRead } = await withAbort(
    handle.read(buffer, 0, BINARY_CHECK_BUFFER_SIZE, 0),
    signal
  );

  if (bytesRead === 0) {
    return Buffer.alloc(0);
  }

  return buffer.subarray(0, bytesRead);
}

function hasUtf16Bom(slice: Buffer): boolean {
  return (
    slice.length >= 2 &&
    ((slice[0] === 0xff && slice[1] === 0xfe) ||
      (slice[0] === 0xfe && slice[1] === 0xff))
  );
}

export async function isProbablyBinary(
  filePath: string,
  existingHandle?: FileHandle,
  signal?: AbortSignal
): Promise<boolean> {
  if (hasKnownBinaryExtension(filePath)) {
    return true;
  }

  if (existingHandle) {
    const slice = await readProbe(existingHandle, signal);
    return isBinarySlice(slice);
  }

  const effectivePath = await validateExistingPath(filePath, signal);
  await using handle = await openReadableFileHandle(effectivePath, signal);
  const slice = await readProbe(handle, signal);
  return isBinarySlice(slice);
}

function isBinarySlice(slice: Buffer): boolean {
  if (slice.length === 0) return false;
  if (hasUtf16Bom(slice)) return false;
  if (slice.includes(0)) return true;
  return !isUtf8(slice);
}

export async function calculateFileContentHash(
  filePath: string,
  signal?: AbortSignal
): Promise<string>;
export async function calculateFileContentHash(
  filePath: string,
  signal: AbortSignal | undefined,
  encoding: BinaryToTextEncoding
): Promise<string>;
export async function calculateFileContentHash(
  filePath: string,
  signal: AbortSignal | undefined,
  encoding: null
): Promise<Buffer>;
export async function calculateFileContentHash(
  filePath: string,
  signal?: AbortSignal,
  encoding: BinaryToTextEncoding | null = 'hex'
): Promise<string | Buffer> {
  const hasher = createHash('sha256');
  await pipeline(
    createReadStream(filePath, { signal, highWaterMark: STREAM_CHUNK_SIZE }),
    hasher,
    { signal }
  );
  return encoding === null ? hasher.digest() : hasher.digest(encoding);
}

type ReadMode = 'head' | 'full' | 'range' | 'tail' | 'byteRange';

interface ReadFileOptions {
  encoding?: BufferEncoding;
  maxSize?: number;
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
  skipBinary?: boolean;
  signal?: AbortSignal;
  offset?: number;
  length?: number;
}

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

interface ReadFileResult {
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

function validateReadOptions(options: ReadFileOptions): void {
  const hasHead = options.head !== undefined;
  const hasTail = options.tail !== undefined;
  const hasStart = options.startLine !== undefined;
  const hasEnd = options.endLine !== undefined;

  assertPositiveSafeIntegerOption(
    'maxSize',
    options.maxSize,
    'maxSize must be at least 1'
  );
  assertPositiveSafeIntegerOption(
    'head',
    options.head,
    'head must be at least 1'
  );
  assertPositiveSafeIntegerOption(
    'tail',
    options.tail,
    'tail must be at least 1'
  );
  assertPositiveSafeIntegerOption(
    'startLine',
    options.startLine,
    'startLine must be at least 1'
  );
  assertPositiveSafeIntegerOption(
    'endLine',
    options.endLine,
    'endLine must be at least 1'
  );

  if (hasHead && (hasStart || hasEnd)) {
    throw new McpError(
      ErrorCode.INVALID_INPUT,
      'head cannot be used together with startLine/endLine'
    );
  }

  if (hasTail && (hasHead || hasStart || hasEnd)) {
    throw new McpError(
      ErrorCode.INVALID_INPUT,
      'tail cannot be used together with head/startLine/endLine'
    );
  }

  // validate offset/length
  if (options.offset !== undefined && options.offset < 0) {
    throw new McpError(ErrorCode.INVALID_INPUT, 'offset must be >= 0');
  }
  if (options.length !== undefined && options.length < 1) {
    throw new McpError(ErrorCode.INVALID_INPUT, 'length must be >= 1');
  }
  const hasByteRange =
    options.offset !== undefined || options.length !== undefined;
  if (hasByteRange && (hasHead || hasTail || hasStart || hasEnd)) {
    throw new McpError(
      ErrorCode.INVALID_INPUT,
      "Cannot use 'offset'/'length' with line-based params"
    );
  }

  {
    const effectiveStart = options.startLine ?? 1;
    if (options.endLine !== undefined && options.endLine < effectiveStart) {
      throw new McpError(
        ErrorCode.INVALID_INPUT,
        'endLine must be greater than or equal to startLine (default: 1)'
      );
    }
  }
}

function normalizeOptions(options: ReadFileOptions): NormalizedOptions {
  validateReadOptions(options);

  const normalized: NormalizedOptions = {
    encoding: options.encoding ?? 'utf-8',
    maxSize: Math.min(
      options.maxSize ?? MAX_TEXT_FILE_SIZE,
      MAX_TEXT_FILE_SIZE
    ),
    skipBinary: options.skipBinary ?? false,
  };

  if (options.head !== undefined) {
    normalized.head = options.head;
  }
  if (options.tail !== undefined) {
    normalized.tail = options.tail;
  }
  if (options.endLine !== undefined) {
    normalized.startLine = options.startLine ?? 1;
    normalized.endLine = options.endLine;
  } else if (options.startLine !== undefined) {
    normalized.startLine = options.startLine;
  }
  if (options.signal) {
    normalized.signal = options.signal;
  }
  if (options.offset !== undefined) {
    normalized.offset = options.offset;
  }
  if (options.length !== undefined) {
    normalized.length = options.length;
  }
  return normalized;
}

function prepareReadOptions(options: ReadFileOptions): NormalizedOptions {
  const normalized = normalizeOptions(options);
  assertNotAborted(normalized.signal);
  return normalized;
}

function buildReadContentOptions(
  normalized: NormalizedOptions
): ReadContentOptions {
  const readOptions: ReadContentOptions = {
    encoding: normalized.encoding,
    maxSize: normalized.maxSize,
  };
  if (normalized.signal) {
    readOptions.signal = normalized.signal;
  }
  return readOptions;
}

function resolveReadMode(options: NormalizedOptions): ReadMode {
  if (options.offset !== undefined || options.length !== undefined)
    return 'byteRange';
  if (options.head !== undefined) return 'head';
  if (options.tail !== undefined) return 'tail';
  if (options.startLine !== undefined || options.endLine !== undefined)
    return 'range';
  return 'full';
}

const STREAM_CHUNK_SIZE = 64 * 1024;

function createTooLargeError(
  bytesRead: number,
  maxSize: number,
  requestedPath: string
): McpError {
  return new McpError(
    ErrorCode.TOO_LARGE,
    `File exceeds size limit (${bytesRead} > ${maxSize} bytes)`,
    requestedPath,
    { size: bytesRead, maxSize }
  );
}

async function readFileBufferWithLimit(
  handle: FileHandle,
  maxSize: number,
  requestedPath: string,
  signal?: AbortSignal
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
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as ArrayBuffer);
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
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) count++;
  }
  return count;
}

async function readHeadContent(
  handle: FileHandle,
  head: number,
  options: ReadContentOptions
): Promise<PartialReadResult> {
  assertNotAborted(options.signal);

  const lines: string[] = [];
  let estimatedBytes = 0;
  const newlineBytes = Buffer.byteLength('\n', options.encoding);
  const iterator = handle
    .readLines({ encoding: options.encoding, signal: options.signal })
    [Symbol.asyncIterator]();

  let hasMoreLines = false;
  let next = await iterator.next();

  try {
    while (!next.done) {
      const line = next.value;
      lines.push(line);

      estimatedBytes +=
        Buffer.byteLength(line, options.encoding) + newlineBytes;
      if (estimatedBytes >= options.maxSize) {
        hasMoreLines = true;
        break;
      }

      if (lines.length === head) {
        const peek = await iterator.next();
        hasMoreLines = !peek.done;
        break;
      }

      next = await iterator.next();
    }
  } finally {
    await iterator.return?.();
  }

  const content = lines.join('\n');
  const linesRead = lines.length;
  return {
    content,
    truncated: hasMoreLines,
    linesRead,
    hasMoreLines,
  };
}

async function readRangeContent(
  handle: FileHandle,
  startLine: number,
  endLine: number | undefined,
  options: ReadContentOptions
): Promise<PartialReadResult> {
  assertNotAborted(options.signal);

  const lines: string[] = [];
  let lineNumber = 0;
  let estimatedBytes = 0;
  const hasEndLine = endLine !== undefined;
  let stoppedByLimit = false;
  let reachedEof = false;
  const newlineBytes = Buffer.byteLength('\n', options.encoding);

  const iterator = handle
    .readLines({ encoding: options.encoding, signal: options.signal })
    [Symbol.asyncIterator]();

  let hasMoreLines = false;

  const stopAt = endLine ?? Number.POSITIVE_INFINITY;

  let stoppedEarly = false;
  let next = await iterator.next();

  try {
    while (!next.done) {
      const line = next.value;
      lineNumber++;

      if (lineNumber < startLine) {
        next = await iterator.next();
        continue;
      }

      if (lineNumber > stopAt) {
        hasMoreLines = true;
        stoppedEarly = true;
        break;
      }

      lines.push(line);

      estimatedBytes +=
        Buffer.byteLength(line, options.encoding) + newlineBytes;
      if (estimatedBytes >= options.maxSize) {
        stoppedByLimit = true;
        stoppedEarly = true;
        break;
      }

      if (hasEndLine && lineNumber === stopAt) {
        const peek = await iterator.next();
        hasMoreLines = !peek.done;
        reachedEof = Boolean(peek.done);
        stoppedEarly = true;
        break;
      }

      next = await iterator.next();
    }
  } finally {
    await iterator.return?.();
  }

  if (!stoppedEarly) {
    reachedEof = true;
  }

  const content = lines.join('\n');
  const linesRead = countLines(content);

  const effectiveHasMoreLines = hasEndLine
    ? hasMoreLines || (stoppedByLimit && !reachedEof)
    : stoppedByLimit && !reachedEof;

  return {
    content,
    truncated: stoppedByLimit || effectiveHasMoreLines,
    linesRead,
    hasMoreLines: effectiveHasMoreLines,
  };
}

async function readTailContent(
  handle: FileHandle,
  tail: number,
  options: ReadContentOptions
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

  const content = lines.join('\n');
  const linesRead = countLines(content);
  const hasMoreLines = totalLines > tail;

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
  signal?: AbortSignal
): Promise<{ content: string; totalLines: number }> {
  const buffer = await readFileBufferWithLimit(
    handle,
    maxSize,
    requestedPath,
    signal
  );
  const content = buffer.toString(encoding);
  return { content, totalLines: countLines(content) };
}

async function assertNotBinary(
  validPath: string,
  filePath: string,
  normalized: NormalizedOptions
): Promise<void> {
  assertNotAborted(normalized.signal);
  const isBinary = await isProbablyBinary(
    validPath,
    undefined,
    normalized.signal
  );
  if (!isBinary) return;
  throw new McpError(
    ErrorCode.INVALID_INPUT,
    'Binary file detected.',
    filePath
  );
}

function assertSizeWithinLimit(
  size: number,
  maxSize: number,
  filePath: string
): void {
  if (size <= maxSize) return;
  throw new McpError(
    ErrorCode.TOO_LARGE,
    `File too large (${size} > ${maxSize} bytes). Use head to preview.`,
    filePath,
    { size, maxSize }
  );
}

type RequiredReadOption = 'head' | 'tail' | 'startLine';

function requireReadOption<K extends RequiredReadOption>(
  normalized: NormalizedOptions,
  key: K,
  filePath: string
): NonNullable<NormalizedOptions[K]> {
  const value = normalized[key];
  if (value !== undefined) {
    return value;
  }

  throw new McpError(
    ErrorCode.INVALID_INPUT,
    `Missing ${key} option`,
    filePath
  );
}

interface ReadModeContext {
  handle: FileHandle;
  validPath: string;
  filePath: string;
  stats: Stats;
  normalized: NormalizedOptions;
}

async function executeHeadRead(
  context: ReadModeContext
): Promise<ReadFileResult> {
  const head = requireReadOption(context.normalized, 'head', context.filePath);
  const readOptions = buildReadContentOptions(context.normalized);
  const { content, truncated, linesRead, hasMoreLines } = await readHeadContent(
    context.handle,
    head,
    readOptions
  );

  return {
    path: context.validPath,
    content,
    truncated,
    readMode: 'head',
    head,
    linesRead,
    hasMoreLines,
  };
}

async function executeRangeRead(
  context: ReadModeContext
): Promise<ReadFileResult> {
  const startLine = requireReadOption(
    context.normalized,
    'startLine',
    context.filePath
  );
  const { endLine } = context.normalized;
  const readOptions = buildReadContentOptions(context.normalized);
  const { content, truncated, linesRead, hasMoreLines } =
    await readRangeContent(context.handle, startLine, endLine, readOptions);

  return {
    path: context.validPath,
    content,
    truncated,
    readMode: 'range',
    startLine,
    ...(endLine !== undefined ? { endLine } : {}),
    linesRead,
    hasMoreLines,
  };
}

async function executeFullRead(
  context: ReadModeContext
): Promise<ReadFileResult> {
  assertSizeWithinLimit(
    context.stats.size,
    context.normalized.maxSize,
    context.filePath
  );
  const { content, totalLines } = await readFullContent(
    context.handle,
    context.normalized.encoding,
    context.normalized.maxSize,
    context.filePath,
    context.normalized.signal
  );

  return {
    path: context.validPath,
    content,
    truncated: false,
    totalLines,
    readMode: 'full',
    linesRead: totalLines,
    hasMoreLines: false,
  };
}

async function executeTailRead(
  context: ReadModeContext
): Promise<ReadFileResult> {
  const tail = requireReadOption(context.normalized, 'tail', context.filePath);
  const readOptions = buildReadContentOptions(context.normalized);
  const { content, truncated, linesRead, hasMoreLines } = await readTailContent(
    context.handle,
    tail,
    readOptions
  );

  return {
    path: context.validPath,
    content,
    truncated,
    readMode: 'tail',
    tail,
    linesRead,
    hasMoreLines,
  };
}

async function executeByteRangeRead(
  context: ReadModeContext
): Promise<ReadFileResult> {
  const start = context.normalized.offset ?? 0;
  const fileSize = context.stats.size;

  // Past EOF — return empty immediately
  if (start >= fileSize) {
    return {
      path: context.validPath,
      content: '',
      truncated: false,
      readMode: 'byteRange',
      offset: start,
      bytesRead: 0,
      reachedEOF: true,
    };
  }

  const { length } = context.normalized;
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

  const stream = context.handle.createReadStream({
    encoding: context.normalized.encoding,
    start,
    ...(end !== undefined ? { end } : {}),
  });

  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as string);
    assertNotAborted(context.normalized.signal);
  }

  const content = chunks.join('');
  const actualEnd = end ?? fileSize - 1;
  const bytesRead = actualEnd - start + 1;

  return {
    path: context.validPath,
    content,
    truncated: false,
    readMode: 'byteRange',
    offset: start,
    bytesRead,
    reachedEOF,
  };
}

const READ_MODE_HANDLERS = {
  head: executeHeadRead,
  range: executeRangeRead,
  full: executeFullRead,
  tail: executeTailRead,
  byteRange: executeByteRangeRead,
} as const satisfies Record<
  ReadMode,
  (context: ReadModeContext) => Promise<ReadFileResult>
>;

async function readByMode(context: ReadModeContext): Promise<ReadFileResult> {
  const mode = resolveReadMode(context.normalized);
  return READ_MODE_HANDLERS[mode](context);
}

function assertFileStats(filePath: string, stats: Stats): void {
  if (!stats.isFile()) {
    throw new McpError(ErrorCode.NOT_FILE, 'Not a regular file', filePath);
  }
}

async function readFileWithStatsInternal(
  filePath: string,
  validPath: string,
  stats: Stats,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  assertNotAborted(normalized.signal);
  assertAllowedFileAccess(filePath, validPath);

  assertFileStats(filePath, stats);

  if (normalized.skipBinary) {
    await assertNotBinary(validPath, filePath, normalized);
  }
  assertNotAborted(normalized.signal);

  await using handle = await openReadableFileHandle(
    validPath,
    normalized.signal
  );
  return await readByMode({
    handle,
    validPath,
    filePath,
    stats,
    normalized,
  });
}

export async function readFileWithStats(
  filePath: string,
  validPath: string,
  stats: Stats,
  options: ReadFileOptions = {}
): Promise<ReadFileResult> {
  const normalized = prepareReadOptions(options);
  return readFileWithStatsInternal(filePath, validPath, stats, normalized);
}

export async function readFile(
  filePath: string,
  options: ReadFileOptions = {}
): Promise<ReadFileResult> {
  const normalized = prepareReadOptions(options);
  const validPath = await validateExistingPath(filePath, normalized.signal);
  assertNotAborted(normalized.signal);
  const stats = await withAbort(stat(validPath), normalized.signal);

  return readFileWithStatsInternal(filePath, validPath, stats, normalized);
}

export async function atomicWriteFile(
  filePath: string,
  content: string,
  options: { encoding?: BufferEncoding; signal?: AbortSignal | undefined } = {}
): Promise<void> {
  const { encoding = 'utf-8', signal } = options;
  const tempPath = `${filePath}.${randomUUID()}.tmp`;

  try {
    assertNotAborted(signal);
    await writeFile(tempPath, content, { encoding, signal });
    await withAbort(rename(tempPath, filePath), signal);
  } catch (error) {
    // Attempt cleanup on error, but don't overwrite the original error
    try {
      await unlink(tempPath).catch(() => undefined);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}
