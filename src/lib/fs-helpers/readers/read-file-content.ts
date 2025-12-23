import * as fs from 'node:fs/promises';

import { headFile } from './head-file.js';
import { readLineRange } from './line-range.js';
import { tailFile } from './tail-file.js';

export async function readLineRangeContent(
  filePath: string,
  lineRange: { start: number; end: number },
  options: { encoding: BufferEncoding; maxSize: number }
): Promise<{ content: string; truncated: boolean }> {
  const result = await readLineRange(
    filePath,
    lineRange.start,
    lineRange.end,
    options.encoding,
    options.maxSize
  );

  const expectedLines = lineRange.end - lineRange.start + 1;
  const truncated =
    lineRange.start > 1 ||
    result.linesRead < expectedLines ||
    result.hasMoreLines;

  return { content: result.content, truncated };
}

export async function readHeadContent(
  filePath: string,
  head: number,
  options: { encoding: BufferEncoding; maxSize: number }
): Promise<{ content: string; truncated: boolean }> {
  const content = await headFile(
    filePath,
    head,
    options.encoding,
    options.maxSize
  );
  return { content, truncated: true };
}

export async function readTailContent(
  filePath: string,
  tail: number,
  options: { encoding: BufferEncoding; maxSize: number }
): Promise<{ content: string; truncated: boolean }> {
  const content = await tailFile(
    filePath,
    tail,
    options.encoding,
    options.maxSize
  );
  return { content, truncated: true };
}

export async function readFullContent(
  filePath: string,
  encoding: BufferEncoding
): Promise<{ content: string; totalLines: number }> {
  const content = await fs.readFile(filePath, { encoding });
  return { content, totalLines: content.split('\n').length };
}
