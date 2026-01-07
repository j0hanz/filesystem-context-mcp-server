import type { FileHandle } from 'node:fs/promises';

import { headFile } from './head-file.js';
import { readLineRange } from './line-range.js';
import { readFileBufferWithLimit } from './read-buffer.js';
import { tailFile } from './tail-file.js';

export async function readLineRangeContent(
  handle: FileHandle,
  lineRange: { start: number; end: number },
  options: { encoding: BufferEncoding; maxSize: number; signal?: AbortSignal }
): Promise<{
  content: string;
  truncated: boolean;
  linesRead: number;
  hasMoreLines: boolean;
}> {
  const result = await readLineRange(
    handle,
    lineRange.start,
    lineRange.end,
    options.encoding,
    options.maxSize,
    options.signal
  );

  const expectedLines = lineRange.end - lineRange.start + 1;
  const truncated =
    lineRange.start > 1 ||
    result.linesRead < expectedLines ||
    result.hasMoreLines;

  return {
    content: result.content,
    truncated,
    linesRead: result.linesRead,
    hasMoreLines: result.hasMoreLines,
  };
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) count++;
  }
  return count;
}

export async function readHeadContent(
  handle: FileHandle,
  head: number,
  options: { encoding: BufferEncoding; maxSize: number; signal?: AbortSignal }
): Promise<{
  content: string;
  truncated: boolean;
  linesRead: number;
  hasMoreLines: boolean;
}> {
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

export async function readTailContent(
  handle: FileHandle,
  fileSize: number,
  tail: number,
  options: { encoding: BufferEncoding; maxSize: number; signal?: AbortSignal }
): Promise<{
  content: string;
  truncated: boolean;
  linesRead: number;
  hasMoreLines: boolean;
}> {
  const content = await tailFile(
    handle,
    fileSize,
    tail,
    options.encoding,
    options.maxSize,
    options.signal
  );
  const linesRead = countLines(content);
  const hasMoreLines = linesRead >= tail;
  return {
    content,
    truncated: hasMoreLines,
    linesRead,
    hasMoreLines,
  };
}

export async function readFullContent(
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
