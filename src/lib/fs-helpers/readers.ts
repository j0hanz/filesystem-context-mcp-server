import * as fs from 'node:fs/promises';
import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { MAX_TEXT_FILE_SIZE } from '../constants.js';
import { ErrorCode, McpError } from '../errors.js';
import { validateExistingPath } from '../path-validation.js';

async function findUTF8Boundary(
  handle: fs.FileHandle,
  position: number
): Promise<number> {
  if (position <= 0) return 0;

  const backtrackSize = Math.min(4, position);
  const startPos = position - backtrackSize;
  const buf = Buffer.allocUnsafe(backtrackSize);

  try {
    const { bytesRead } = await handle.read(buf, 0, backtrackSize, startPos);

    for (let i = bytesRead - 1; i >= 0; i--) {
      const byte = buf[i];
      if (byte !== undefined && (byte & 0xc0) !== 0x80) {
        return startPos + i;
      }
    }
  } catch (error) {
    console.error(
      `[findUTF8Boundary] Read error at position ${position}:`,
      error instanceof Error ? error.message : String(error)
    );
    return position;
  }

  return position;
}

export async function tailFile(
  filePath: string,
  numLines: number
): Promise<string> {
  const CHUNK_SIZE = 256 * 1024;
  const validPath = await validateExistingPath(filePath);
  const stats = await fs.stat(validPath);
  const fileSize = stats.size;

  if (fileSize === 0) return '';

  const handle = await fs.open(validPath, 'r');
  try {
    const lines: string[] = [];
    let position = fileSize;
    const chunk = Buffer.alloc(CHUNK_SIZE + 4);
    let linesFound = 0;
    let remainingText = '';

    while (position > 0 && linesFound < numLines) {
      let size = Math.min(CHUNK_SIZE, position);
      let startPos = position - size;

      if (startPos > 0) {
        const alignedPos = await findUTF8Boundary(handle, startPos);
        size = position - alignedPos;
        startPos = alignedPos;
      }

      position = startPos;

      const { bytesRead } = await handle.read(chunk, 0, size, position);
      if (bytesRead === 0) break;

      const readData = chunk.subarray(0, bytesRead).toString('utf-8');
      const chunkText = readData + remainingText;
      const chunkLines = chunkText.replace(/\r\n/g, '\n').split('\n');

      if (position > 0) {
        remainingText = chunkLines[0] ?? '';
        chunkLines.shift();
      }

      for (
        let i = chunkLines.length - 1;
        i >= 0 && linesFound < numLines;
        i--
      ) {
        const line = chunkLines[i];
        if (line !== undefined) {
          lines.unshift(line);
          linesFound++;
        }
      }
    }

    return lines.join('\n');
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function headFile(
  filePath: string,
  numLines: number
): Promise<string> {
  const validPath = await validateExistingPath(filePath);
  const handle = await fs.open(validPath, 'r');
  try {
    const lines: string[] = [];
    let bytesRead = 0;
    const chunk = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder('utf-8');
    let buffer = '';

    while (lines.length < numLines) {
      const result = await handle.read(chunk, 0, chunk.length, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;

      buffer += decoder.write(chunk.subarray(0, result.bytesRead));
      const normalizedBuffer = buffer.replace(/\r\n/g, '\n');
      const newLineIndex = normalizedBuffer.lastIndexOf('\n');

      if (newLineIndex !== -1) {
        const completeLines = normalizedBuffer
          .substring(0, newLineIndex)
          .split('\n');
        buffer = normalizedBuffer.substring(newLineIndex + 1);

        for (const line of completeLines) {
          lines.push(line);
          if (lines.length >= numLines) break;
        }
      }
    }

    buffer += decoder.end();
    if (buffer.length > 0 && lines.length < numLines) {
      const remainingLines = buffer.replace(/\r\n/g, '\n').split('\n');
      for (const line of remainingLines) {
        lines.push(line);
        if (lines.length >= numLines) break;
      }
    }

    return lines.slice(0, numLines).join('\n');
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readLineRange(
  filePath: string,
  startLine: number,
  endLine: number
): Promise<{
  content: string;
  linesRead: number;
  totalLinesScanned: number;
  hasMoreLines: boolean;
}> {
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const lines: string[] = [];
  let lineNumber = 0;
  let hasMoreLines = false;

  try {
    for await (const line of rl) {
      lineNumber++;

      if (lineNumber >= startLine && lineNumber <= endLine) {
        lines.push(line);
      }

      if (lineNumber > endLine) {
        hasMoreLines = true;
        break;
      }
    }

    return {
      content: lines.join('\n'),
      linesRead: lines.length,
      totalLinesScanned: lineNumber,
      hasMoreLines,
    };
  } finally {
    rl.close();
    fileStream.destroy();
  }
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
  const {
    encoding = 'utf-8',
    maxSize = MAX_TEXT_FILE_SIZE,
    lineRange,
    head,
    tail,
  } = options;
  const validPath = await validateExistingPath(filePath);

  const stats = await fs.stat(validPath);

  if (!stats.isFile()) {
    throw new McpError(
      ErrorCode.E_NOT_FILE,
      `Not a file: ${filePath}`,
      filePath
    );
  }

  const optionsCount = [lineRange, head, tail].filter(Boolean).length;
  if (optionsCount > 1) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Cannot specify multiple of lineRange, head, or tail simultaneously',
      filePath
    );
  }

  if (lineRange) {
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

  if (tail !== undefined) {
    const content = await tailFile(validPath, tail);
    return { path: validPath, content, truncated: true, totalLines: undefined };
  }

  if (head !== undefined) {
    const content = await headFile(validPath, head);
    return { path: validPath, content, truncated: true, totalLines: undefined };
  }

  if (lineRange) {
    const result = await readLineRange(
      validPath,
      lineRange.start,
      lineRange.end
    );
    const expectedLines = lineRange.end - lineRange.start + 1;
    const isTruncated =
      lineRange.start > 1 ||
      result.linesRead < expectedLines ||
      result.hasMoreLines;
    return {
      path: validPath,
      content: result.content,
      truncated: isTruncated,
      totalLines: undefined,
    };
  }

  if (stats.size > maxSize) {
    throw new McpError(
      ErrorCode.E_TOO_LARGE,
      `File too large: ${stats.size} bytes (max: ${maxSize} bytes). Use head, tail, or lineRange for partial reads.`,
      filePath,
      { size: stats.size, maxSize }
    );
  }

  const content = await fs.readFile(validPath, { encoding });

  const totalLines = content.split('\n').length;

  return { path: validPath, content, truncated: false, totalLines };
}
