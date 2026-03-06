import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import type { FileType } from '../config.js';
import {
  BINARY_CHECK_BUFFER_SIZE,
  KNOWN_BINARY_EXTENSIONS,
  MAX_TEXT_FILE_SIZE,
  PARALLEL_CONCURRENCY,
} from './constants.js';
import { ErrorCode, McpError, normalizeUnknownError } from './errors.js';
import { assertAllowedFileAccess, validateExistingPath } from './paths.js';

function createAbortError(message = 'Operation aborted'): Error {
  return new DOMException(message, 'AbortError');
}

const READ_ONLY_FILE_FLAG = 'r';
const SHARED_NOOP_SIGNAL = new AbortController().signal;

function normalizeAbortReason(reason: unknown, message?: string): Error {
  if (reason instanceof Error) return reason;
  return createAbortError(message);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function assertNotAborted(signal?: AbortSignal, message?: string): void {
  if (!signal) return;
  try {
    signal.throwIfAborted();
  } catch (reason) {
    throw normalizeAbortReason(reason, message);
  }
}

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
      ErrorCode.E_INVALID_INPUT,
      message ?? `${name} must be a positive integer`
    );
  }
}

function normalizeConcurrency(concurrency: number): number {
  assertPositiveSafeIntegerOption('concurrency', concurrency);
  return concurrency;
}

function getAbortError(signal: AbortSignal, message?: string): Error {
  try {
    signal.throwIfAborted();
  } catch (reason) {
    return normalizeAbortReason(reason, message);
  }
  return createAbortError(message);
}

export function withAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(getAbortError(signal));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(normalizeUnknownError(error));
      }
    );
  });
}

export function createTimedAbortSignal(
  baseSignal: AbortSignal | undefined,
  timeoutMs?: number
): { signal: AbortSignal; cleanup: () => void } {
  const timeoutSignal = isFiniteNumber(timeoutMs)
    ? AbortSignal.timeout(timeoutMs)
    : undefined;

  if (baseSignal && timeoutSignal) {
    return {
      signal: AbortSignal.any([baseSignal, timeoutSignal]),
      cleanup: () => {},
    };
  }

  if (baseSignal) {
    return { signal: baseSignal, cleanup: () => {} };
  }

  if (timeoutSignal) {
    return { signal: timeoutSignal, cleanup: () => {} };
  }

  return { signal: SHARED_NOOP_SIGNAL, cleanup: () => {} };
}

export async function withTimedAbortSignal<T>(
  baseSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const { signal, cleanup } = createTimedAbortSignal(baseSignal, timeoutMs);
  try {
    return await run(signal);
  } finally {
    cleanup();
  }
}

interface ParallelResult<R> {
  results: R[];
  errors: { index: number; error: Error }[];
}

function createParallelAbortError(): Error {
  return createAbortError();
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
  const resultSlots: (R | undefined)[] = new Array<R | undefined>(itemCount);
  const errors: { index: number; error: Error }[] = [];

  if (signal?.aborted) throw createParallelAbortError();

  let nextIndex = 0;

  const next = async (): Promise<void> => {
    while (nextIndex < itemCount) {
      if (signal?.aborted) throw createParallelAbortError();

      const index = nextIndex;
      nextIndex += 1;

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
    if (slot !== undefined) {
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
  const ext = path.extname(filePath).toLowerCase();
  return KNOWN_BINARY_EXTENSIONS.has(ext);
}

async function openReadableFileHandle(
  filePath: string,
  signal?: AbortSignal
): Promise<FileHandle> {
  return withAbort(fsp.open(filePath, READ_ONLY_FILE_FLAG), signal);
}

async function readProbe(
  handle: fsp.FileHandle,
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
  existingHandle?: fsp.FileHandle,
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

type ReadMode = 'head' | 'full' | 'range' | 'tail';

interface ReadFileOptions {
  encoding?: BufferEncoding;
  maxSize?: number;
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
  skipBinary?: boolean;
  signal?: AbortSignal;
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
      ErrorCode.E_INVALID_INPUT,
      'head cannot be used together with startLine/endLine'
    );
  }

  if (hasTail && (hasHead || hasStart || hasEnd)) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'tail cannot be used together with head/startLine/endLine'
    );
  }

  if (hasEnd && !hasStart) {
    throw new McpError(ErrorCode.E_INVALID_INPUT, 'endLine requires startLine');
  }

  if (
    options.startLine !== undefined &&
    options.endLine !== undefined &&
    options.endLine < options.startLine
  ) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'endLine must be greater than or equal to startLine'
    );
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
  if (options.startLine !== undefined) {
    normalized.startLine = options.startLine;
  }
  if (options.endLine !== undefined) {
    normalized.endLine = options.endLine;
  }
  if (options.signal) {
    normalized.signal = options.signal;
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
  if (options.head !== undefined) return 'head';
  if (options.tail !== undefined) return 'tail';
  if (options.startLine !== undefined) return 'range';
  return 'full';
}

const STREAM_CHUNK_SIZE = 64 * 1024;

function createTooLargeError(
  bytesRead: number,
  maxSize: number,
  requestedPath: string
): McpError {
  return new McpError(
    ErrorCode.E_TOO_LARGE,
    `File exceeds maximum size (${bytesRead} > ${maxSize}): ${requestedPath}`,
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

async function headFile(
  handle: fsp.FileHandle,
  numLines: number,
  encoding: BufferEncoding = 'utf-8',
  maxBytesRead?: number,
  signal?: AbortSignal
): Promise<string> {
  assertNotAborted(signal);

  const lines: string[] = [];
  let estimatedBytes = 0;
  const hasMaxBytes = maxBytesRead !== undefined;
  const newlineBytes = Buffer.byteLength('\n', encoding);

  for await (const line of handle.readLines({ encoding, signal })) {
    lines.push(line);

    if (lines.length >= numLines) break;
    if (!hasMaxBytes) continue;

    estimatedBytes += Buffer.byteLength(line, encoding) + newlineBytes;
    if (estimatedBytes >= maxBytesRead) break;
  }

  return lines.join('\n');
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
  const content = await headFile(
    handle,
    head,
    options.encoding,
    options.maxSize,
    options.signal
  );
  const linesRead = countLines(content);
  const hasMoreLines = linesRead >= head;
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
    ErrorCode.E_INVALID_INPUT,
    `Binary file detected: ${filePath}. Refusing to read as text.`,
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
    ErrorCode.E_TOO_LARGE,
    `File too large: ${size} bytes (max: ${maxSize} bytes). Use head parameter to preview the first N lines.`,
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
    return value as NonNullable<NormalizedOptions[K]>;
  }

  throw new McpError(
    ErrorCode.E_INVALID_INPUT,
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

const READ_MODE_HANDLERS = {
  head: executeHeadRead,
  range: executeRangeRead,
  full: executeFullRead,
  tail: executeTailRead,
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
    throw new McpError(
      ErrorCode.E_NOT_FILE,
      `Not a file: ${filePath}`,
      filePath
    );
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
  const stats = await withAbort(fsp.stat(validPath), normalized.signal);

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
    await fsp.writeFile(tempPath, content, { encoding, signal });
    await withAbort(fsp.rename(tempPath, filePath), signal);
  } catch (error) {
    // Attempt cleanup on error, but don't overwrite the original error
    try {
      await fsp.unlink(tempPath).catch(() => {});
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

export { headFile };
