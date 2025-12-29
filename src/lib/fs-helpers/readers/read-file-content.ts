import { headFile } from './head-file.js';
import { readLineRange } from './line-range.js';
import { readFileBufferWithLimit } from './read-buffer.js';
import { tailFile } from './tail-file.js';

export async function readLineRangeContent(
  filePath: string,
  lineRange: { start: number; end: number },
  options: { encoding: BufferEncoding; maxSize: number; signal?: AbortSignal }
): Promise<{
  content: string;
  truncated: boolean;
  linesRead: number;
  totalLinesScanned: number;
  hasMoreLines: boolean;
}> {
  const result = await readLineRange(
    filePath,
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
    totalLinesScanned: result.totalLinesScanned,
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
  filePath: string,
  head: number,
  options: { encoding: BufferEncoding; maxSize: number; signal?: AbortSignal }
): Promise<{
  content: string;
  truncated: boolean;
  linesRead: number;
  hasMoreLines: boolean;
}> {
  const content = await headFile(
    filePath,
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
  filePath: string,
  tail: number,
  options: { encoding: BufferEncoding; maxSize: number; signal?: AbortSignal }
): Promise<{
  content: string;
  truncated: boolean;
  linesRead: number;
  hasMoreLines: boolean;
}> {
  const content = await tailFile(
    filePath,
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
  filePath: string,
  encoding: BufferEncoding,
  maxSize: number,
  requestedPath: string = filePath,
  signal?: AbortSignal
): Promise<{ content: string; totalLines: number }> {
  const buffer = await readFileBufferWithLimit(
    filePath,
    maxSize,
    requestedPath,
    signal
  );
  const content = buffer.toString(encoding);
  return { content, totalLines: countLines(content) };
}
