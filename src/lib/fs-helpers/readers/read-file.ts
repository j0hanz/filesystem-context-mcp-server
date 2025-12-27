import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';

import { MAX_TEXT_FILE_SIZE } from '../../constants.js';
import { ErrorCode, McpError } from '../../errors.js';
import { validateExistingPath } from '../../path-validation.js';
import { isProbablyBinary } from '../binary-detect.js';
import {
  readFullContent,
  readHeadContent,
  readLineRangeContent,
  readTailContent,
} from './read-file-content.js';

interface NormalizedOptions {
  encoding: BufferEncoding;
  maxSize: number;
  lineRange?: { start: number; end: number };
  head?: number;
  tail?: number;
  skipBinary: boolean;
}

interface ReadFileOptions {
  encoding?: BufferEncoding;
  maxSize?: number;
  lineRange?: { start: number; end: number };
  head?: number;
  tail?: number;
  skipBinary?: boolean;
}

interface ReadFileResult {
  path: string;
  content: string;
  truncated: boolean;
  totalLines?: number;
}

type ReadMode = 'lineRange' | 'tail' | 'head' | 'full';

function normalizeOptions(options: ReadFileOptions): NormalizedOptions {
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
  totalLines?: number
): ReadFileResult {
  return { path: filePath, content, truncated, totalLines };
}

async function readLineRangeResult(
  validPath: string,
  filePath: string,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  const lineRange = requireOption(normalized.lineRange, 'lineRange', filePath);
  validateLineRange(lineRange, filePath);
  assertLineRangeWithinLimit(lineRange, filePath);
  const { content, truncated } = await readLineRangeContent(
    validPath,
    lineRange,
    {
      encoding: normalized.encoding,
      maxSize: normalized.maxSize,
    }
  );
  return buildReadResult(validPath, content, truncated);
}

async function readTailResult(
  validPath: string,
  filePath: string,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  const tail = requireOption(normalized.tail, 'tail', filePath);
  const { content, truncated } = await readTailContent(validPath, tail, {
    encoding: normalized.encoding,
    maxSize: normalized.maxSize,
  });
  return buildReadResult(validPath, content, truncated);
}

async function readHeadResult(
  validPath: string,
  filePath: string,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  const head = requireOption(normalized.head, 'head', filePath);
  const { content, truncated } = await readHeadContent(validPath, head, {
    encoding: normalized.encoding,
    maxSize: normalized.maxSize,
  });
  return buildReadResult(validPath, content, truncated);
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
    filePath
  );
  return buildReadResult(validPath, content, false, totalLines);
}

async function readByMode(
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

async function assertNotBinary(
  validPath: string,
  filePath: string
): Promise<void> {
  const isBinary = await isProbablyBinary(validPath);
  if (!isBinary) return;
  throw new McpError(
    ErrorCode.E_INVALID_INPUT,
    `Binary file detected: ${filePath}. Set skipBinary=false to read as text.`,
    filePath
  );
}

export async function readFile(
  filePath: string,
  options: ReadFileOptions = {}
): Promise<ReadFileResult> {
  const normalized = normalizeOptions(options);
  const validPath = await validateExistingPath(filePath);
  const stats = await fs.stat(validPath);

  assertIsFile(stats, filePath);
  assertSingleMode(normalized, filePath);
  if (normalized.skipBinary) {
    await assertNotBinary(validPath, filePath);
  }

  return await readByMode(validPath, filePath, stats, normalized);
}
