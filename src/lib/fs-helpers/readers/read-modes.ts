import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import { ErrorCode, McpError } from '../../errors.js';
import {
  readFullContent,
  readHeadContent,
  readLineRangeContent,
  readTailContent,
} from './read-file-content.js';
import {
  type NormalizedOptions,
  type ReadFileResult,
  resolveReadMode,
} from './read-options.js';

type ReadResultMetadata = Omit<
  ReadFileResult,
  'path' | 'content' | 'truncated' | 'totalLines'
>;

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
  handle: FileHandle,
  validPath: string,
  filePath: string,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  const lineRange = requireOption(normalized.lineRange, 'lineRange', filePath);
  validateLineRange(lineRange, filePath);
  assertLineRangeWithinLimit(lineRange, filePath);
  const { content, truncated, linesRead, hasMoreLines } =
    await readLineRangeContent(handle, lineRange, {
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
  handle: FileHandle,
  fileSize: number,
  validPath: string,
  filePath: string,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  const tail = requireOption(normalized.tail, 'tail', filePath);
  const { content, truncated, linesRead, hasMoreLines } = await readTailContent(
    handle,
    fileSize,
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
  handle: FileHandle,
  validPath: string,
  filePath: string,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  const head = requireOption(normalized.head, 'head', filePath);
  const { content, truncated, linesRead, hasMoreLines } = await readHeadContent(
    handle,
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
  handle: FileHandle,
  validPath: string,
  filePath: string,
  stats: Stats,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  assertWithinMaxSize(stats, normalized.maxSize, filePath);
  const { content, totalLines } = await readFullContent(
    handle,
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
  handle: FileHandle,
  validPath: string,
  filePath: string,
  stats: Stats,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  const mode = resolveReadMode(normalized);
  if (mode === 'lineRange') {
    return await readLineRangeResult(handle, validPath, filePath, normalized);
  }
  if (mode === 'tail') {
    return await readTailResult(
      handle,
      stats.size,
      validPath,
      filePath,
      normalized
    );
  }
  if (mode === 'head') {
    return await readHeadResult(handle, validPath, filePath, normalized);
  }

  return await readFullResult(handle, validPath, filePath, stats, normalized);
}
