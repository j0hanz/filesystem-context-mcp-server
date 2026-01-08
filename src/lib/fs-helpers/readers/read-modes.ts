import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import { ErrorCode, McpError } from '../../errors.js';
import { readFullContent, readHeadContent } from './read-file-content.js';
import {
  type NormalizedOptions,
  type ReadFileResult,
  resolveReadMode,
} from './read-options.js';

function requireHead(normalized: NormalizedOptions, filePath: string): number {
  if (normalized.head === undefined) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Missing head option',
      filePath
    );
  }
  return normalized.head;
}

function buildHeadResult(
  validPath: string,
  content: string,
  truncated: boolean,
  head: number,
  linesRead: number,
  hasMoreLines: boolean
): ReadFileResult {
  return {
    path: validPath,
    content,
    truncated,
    totalLines: undefined,
    readMode: 'head',
    head,
    linesRead,
    hasMoreLines,
  };
}

function buildFullResult(
  validPath: string,
  content: string,
  totalLines: number
): ReadFileResult {
  return {
    path: validPath,
    content,
    truncated: false,
    totalLines,
    readMode: 'full',
    linesRead: totalLines,
    hasMoreLines: false,
  };
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

async function readHeadResult(
  handle: FileHandle,
  validPath: string,
  filePath: string,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  const head = requireHead(normalized, filePath);
  const { content, truncated, linesRead, hasMoreLines } = await readHeadContent(
    handle,
    head,
    {
      encoding: normalized.encoding,
      maxSize: normalized.maxSize,
      signal: normalized.signal,
    }
  );
  return buildHeadResult(
    validPath,
    content,
    truncated,
    head,
    linesRead,
    hasMoreLines
  );
}

async function readFullResult(
  handle: FileHandle,
  validPath: string,
  filePath: string,
  stats: Stats,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  assertSizeWithinLimit(stats.size, normalized.maxSize, filePath);
  const { content, totalLines } = await readFullContent(
    handle,
    normalized.encoding,
    normalized.maxSize,
    filePath,
    normalized.signal
  );
  return buildFullResult(validPath, content, totalLines);
}

export async function readByMode(
  handle: FileHandle,
  validPath: string,
  filePath: string,
  stats: Stats,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  const mode = resolveReadMode(normalized);
  if (mode === 'head') {
    return await readHeadResult(handle, validPath, filePath, normalized);
  }
  return await readFullResult(handle, validPath, filePath, stats, normalized);
}
