import type { Stats } from 'node:fs';

import { MAX_TEXT_FILE_SIZE } from '../../constants.js';
import { ErrorCode, McpError } from '../../errors.js';
import { assertNotAborted } from '../abort.js';
import { isProbablyBinary } from '../binary-detect.js';
import {
  readFullContent,
  readHeadContent,
  readLineRangeContent,
  readTailContent,
} from './read-file-content.js';

export type ReadMode = 'lineRange' | 'tail' | 'head' | 'full';

export interface ReadFileOptions {
  encoding?: BufferEncoding;
  maxSize?: number;
  lineRange?: { start: number; end: number };
  head?: number;
  tail?: number;
  skipBinary?: boolean;
  signal?: AbortSignal;
}

export interface NormalizedOptions {
  encoding: BufferEncoding;
  maxSize: number;
  lineRange?: { start: number; end: number };
  head?: number;
  tail?: number;
  skipBinary: boolean;
  signal?: AbortSignal;
}

export interface ReadFileResult {
  path: string;
  content: string;
  truncated: boolean;
  totalLines?: number;
  readMode: ReadMode;
  lineStart?: number;
  lineEnd?: number;
  head?: number;
  tail?: number;
  linesRead?: number;
  hasMoreLines?: boolean;
}

export type ReadResultMetadata = Omit<
  ReadFileResult,
  'path' | 'content' | 'truncated' | 'totalLines'
>;

export function normalizeOptions(options: ReadFileOptions): NormalizedOptions {
  return {
    encoding: options.encoding ?? 'utf-8',
    maxSize: Math.min(
      options.maxSize ?? MAX_TEXT_FILE_SIZE,
      MAX_TEXT_FILE_SIZE
    ),
    lineRange: options.lineRange,
    head: options.head,
    tail: options.tail,
    skipBinary: options.skipBinary ?? false,
    signal: options.signal,
  };
}

export function assertIsFile(stats: Stats, filePath: string): void {
  if (stats.isFile()) return;
  throw new McpError(ErrorCode.E_NOT_FILE, `Not a file: ${filePath}`, filePath);
}

export function assertSingleMode(
  options: NormalizedOptions,
  filePath: string
): void {
  const optionsCount = [options.lineRange, options.head, options.tail].filter(
    Boolean
  ).length;
  if (optionsCount <= 1) return;

  throw new McpError(
    ErrorCode.E_INVALID_INPUT,
    'Cannot specify multiple of lineRange, head, or tail simultaneously',
    filePath
  );
}

function validateLineRange(
  lineRange: { start: number; end: number },
  filePath: string
): void {
  if (lineRange.start < 1) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      `Invalid lineRange: start must be at least 1 (got ${lineRange.start})`,
      filePath
    );
  }
  if (lineRange.end < lineRange.start) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      `Invalid lineRange: end (${lineRange.end}) must be >= start (${lineRange.start})`,
      filePath
    );
  }
}

function resolveReadMode(options: NormalizedOptions): ReadMode {
  if (options.lineRange) return 'lineRange';
  if (options.tail !== undefined) return 'tail';
  if (options.head !== undefined) return 'head';
  return 'full';
}

function assertWithinMaxSize(
  stats: Stats,
  maxSize: number,
  filePath: string
): void {
  if (stats.size <= maxSize) return;
  throw new McpError(
    ErrorCode.E_TOO_LARGE,
    `File too large: ${stats.size} bytes (max: ${maxSize} bytes). Use head, tail, or lineRange for partial reads.`,
    filePath,
    { size: stats.size, maxSize }
  );
}

function requireOption<T>(
  value: T | undefined,
  name: string,
  filePath: string
): T {
  if (value !== undefined) return value;
  throw new McpError(
    ErrorCode.E_INVALID_INPUT,
    `Missing ${name} option`,
    filePath
  );
}

function assertLineRangeWithinLimit(
  lineRange: { start: number; end: number },
  filePath: string
): void {
  const maxLineRange = 100000;
  const requestedLines = lineRange.end - lineRange.start + 1;
  if (requestedLines <= maxLineRange) return;
  throw new McpError(
    ErrorCode.E_INVALID_INPUT,
    `Invalid lineRange: range too large (max ${maxLineRange} lines)`,
    filePath,
    { requestedLines, maxLineRange }
  );
}

function buildReadResult(
  filePath: string,
  content: string,
  truncated: boolean,
  totalLines: number | undefined,
  metadata: ReadResultMetadata
): ReadFileResult {
  return { path: filePath, content, truncated, totalLines, ...metadata };
}

async function readLineRangeResult(
  validPath: string,
  filePath: string,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  const lineRange = requireOption(normalized.lineRange, 'lineRange', filePath);
  validateLineRange(lineRange, filePath);
  assertLineRangeWithinLimit(lineRange, filePath);
  const { content, truncated, linesRead, hasMoreLines } =
    await readLineRangeContent(validPath, lineRange, {
      encoding: normalized.encoding,
      maxSize: normalized.maxSize,
      signal: normalized.signal,
    });
  return buildReadResult(validPath, content, truncated, undefined, {
    readMode: 'lineRange',
    lineStart: lineRange.start,
    lineEnd: lineRange.end,
    linesRead,
    hasMoreLines,
  });
}

async function readTailResult(
  validPath: string,
  filePath: string,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  const tail = requireOption(normalized.tail, 'tail', filePath);
  const { content, truncated, linesRead, hasMoreLines } = await readTailContent(
    validPath,
    tail,
    {
      encoding: normalized.encoding,
      maxSize: normalized.maxSize,
      signal: normalized.signal,
    }
  );
  return buildReadResult(validPath, content, truncated, undefined, {
    readMode: 'tail',
    tail,
    linesRead,
    hasMoreLines,
  });
}

async function readHeadResult(
  validPath: string,
  filePath: string,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  const head = requireOption(normalized.head, 'head', filePath);
  const { content, truncated, linesRead, hasMoreLines } = await readHeadContent(
    validPath,
    head,
    {
      encoding: normalized.encoding,
      maxSize: normalized.maxSize,
      signal: normalized.signal,
    }
  );
  return buildReadResult(validPath, content, truncated, undefined, {
    readMode: 'head',
    head,
    linesRead,
    hasMoreLines,
  });
}

async function readFullResult(
  validPath: string,
  filePath: string,
  stats: Stats,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  assertWithinMaxSize(stats, normalized.maxSize, filePath);
  const { content, totalLines } = await readFullContent(
    validPath,
    normalized.encoding,
    normalized.maxSize,
    filePath,
    normalized.signal
  );
  return buildReadResult(validPath, content, false, totalLines, {
    readMode: 'full',
    linesRead: totalLines,
    hasMoreLines: false,
  });
}

export async function readByMode(
  validPath: string,
  filePath: string,
  stats: Stats,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  const mode = resolveReadMode(normalized);
  if (mode === 'lineRange') {
    return await readLineRangeResult(validPath, filePath, normalized);
  }
  if (mode === 'tail') {
    return await readTailResult(validPath, filePath, normalized);
  }
  if (mode === 'head') {
    return await readHeadResult(validPath, filePath, normalized);
  }

  return await readFullResult(validPath, filePath, stats, normalized);
}

export async function assertNotBinary(
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
    `Binary file detected: ${filePath}. Set skipBinary=false to read as text.`,
    filePath
  );
}
