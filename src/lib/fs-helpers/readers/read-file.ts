import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';

import { MAX_TEXT_FILE_SIZE } from '../../constants.js';
import { ErrorCode, McpError } from '../../errors.js';
import { validateExistingPath } from '../../path-validation.js';
import { headFile } from './head-file.js';
import { readLineRange } from './line-range.js';
import { tailFile } from './tail-file.js';

interface NormalizedOptions {
  encoding: BufferEncoding;
  maxSize: number;
  lineRange?: { start: number; end: number };
  head?: number;
  tail?: number;
}

function normalizeOptions(options: {
  encoding?: BufferEncoding;
  maxSize?: number;
  lineRange?: { start: number; end: number };
  head?: number;
  tail?: number;
}): NormalizedOptions {
  return {
    encoding: options.encoding ?? 'utf-8',
    maxSize: Math.min(
      options.maxSize ?? MAX_TEXT_FILE_SIZE,
      MAX_TEXT_FILE_SIZE
    ),
    lineRange: options.lineRange,
    head: options.head,
    tail: options.tail,
  };
}

function assertIsFile(stats: Stats, filePath: string): void {
  if (stats.isFile()) return;
  throw new McpError(ErrorCode.E_NOT_FILE, `Not a file: ${filePath}`, filePath);
}

function assertSingleMode(options: NormalizedOptions, filePath: string): void {
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

async function readLineRangeContent(
  filePath: string,
  options: NormalizedOptions
): Promise<{ content: string; truncated: boolean }> {
  const lineRange = options.lineRange as { start: number; end: number };
  const maxLineRange = 100000;
  const requestedLines = lineRange.end - lineRange.start + 1;
  if (requestedLines > maxLineRange) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      `Invalid lineRange: range too large (max ${maxLineRange} lines)`,
      filePath,
      { requestedLines, maxLineRange }
    );
  }

  const result = await readLineRange(
    filePath,
    lineRange.start,
    lineRange.end,
    options.encoding,
    options.maxSize
  );

  const expectedLines = lineRange.end - lineRange.start + 1;
  const isTruncated =
    lineRange.start > 1 ||
    result.linesRead < expectedLines ||
    result.hasMoreLines;

  return { content: result.content, truncated: isTruncated };
}

async function readHeadContent(
  filePath: string,
  head: number,
  options: NormalizedOptions
): Promise<{ content: string; truncated: boolean }> {
  const content = await headFile(
    filePath,
    head,
    options.encoding,
    options.maxSize
  );
  return { content, truncated: true };
}

async function readTailContent(
  filePath: string,
  tail: number,
  options: NormalizedOptions
): Promise<{ content: string; truncated: boolean }> {
  const content = await tailFile(
    filePath,
    tail,
    options.encoding,
    options.maxSize
  );
  return { content, truncated: true };
}

async function readFullContent(
  filePath: string,
  encoding: BufferEncoding
): Promise<{ content: string; totalLines: number }> {
  const content = await fs.readFile(filePath, { encoding });
  return { content, totalLines: content.split('\n').length };
}

export async function readFile(
  filePath: string,
  options: {
    encoding?: BufferEncoding;
    maxSize?: number;
    lineRange?: { start: number; end: number };
    head?: number;
    tail?: number;
  } = {}
): Promise<{
  path: string;
  content: string;
  truncated: boolean;
  totalLines?: number;
}> {
  const normalized = normalizeOptions(options);
  const validPath = await validateExistingPath(filePath);
  const stats = await fs.stat(validPath);

  assertIsFile(stats, filePath);
  assertSingleMode(normalized, filePath);

  if (normalized.lineRange) {
    validateLineRange(normalized.lineRange, filePath);
    const { content, truncated } = await readLineRangeContent(
      validPath,
      normalized
    );
    return { path: validPath, content, truncated, totalLines: undefined };
  }

  if (normalized.tail !== undefined) {
    const { content, truncated } = await readTailContent(
      validPath,
      normalized.tail,
      normalized
    );
    return { path: validPath, content, truncated, totalLines: undefined };
  }

  if (normalized.head !== undefined) {
    const { content, truncated } = await readHeadContent(
      validPath,
      normalized.head,
      normalized
    );
    return { path: validPath, content, truncated, totalLines: undefined };
  }

  if (stats.size > normalized.maxSize) {
    throw new McpError(
      ErrorCode.E_TOO_LARGE,
      `File too large: ${stats.size} bytes (max: ${normalized.maxSize} bytes). Use head, tail, or lineRange for partial reads.`,
      filePath,
      { size: stats.size, maxSize: normalized.maxSize }
    );
  }

  const { content, totalLines } = await readFullContent(
    validPath,
    normalized.encoding
  );

  return { path: validPath, content, truncated: false, totalLines };
}
