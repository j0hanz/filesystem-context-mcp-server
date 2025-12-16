import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { Stats } from 'node:fs';
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import type { FileType, ParallelResult } from '../config/types.js';
import {
  BINARY_CHECK_BUFFER_SIZE,
  KNOWN_BINARY_EXTENSIONS,
  KNOWN_TEXT_EXTENSIONS,
  MAX_TEXT_FILE_SIZE,
  PARALLEL_CONCURRENCY,
} from './constants.js';
import { ErrorCode, McpError } from './errors.js';
import { validateExistingPath } from './path-validation.js';

// Concurrent work queue processor with abort support
export async function runWorkQueue<T>(
  initialItems: T[],
  worker: (item: T, enqueue: (item: T) => void) => Promise<void>,
  concurrency: number,
  signal?: AbortSignal
): Promise<void> {
  const queue: T[] = [...initialItems];
  let head = 0;
  let inFlight = 0;
  let aborted = false;
  let doneResolve: (() => void) | undefined;
  const donePromise = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });

  const onAbort = (): void => {
    aborted = true;
    // Don't modify queue - just stop new work from being enqueued
    if (inFlight === 0) {
      doneResolve?.();
    }
  };

  signal?.addEventListener('abort', onAbort, { once: true });

  const maybeCompactQueue = (): void => {
    if (head > 1024 && head * 2 > queue.length) {
      queue.splice(0, head);
      head = 0;
    }
  };

  const maybeStartNext = (): void => {
    if (aborted) return;

    while (inFlight < concurrency && head < queue.length) {
      const next = queue[head];
      if (next === undefined) break;
      head++;

      inFlight++;
      void worker(next, (item: T) => {
        if (!aborted) {
          queue.push(item);
          maybeStartNext();
        }
      }).finally(() => {
        inFlight--;
        maybeCompactQueue();
        if (inFlight === 0 && (head >= queue.length || aborted)) {
          doneResolve?.();
        } else if (!aborted) {
          maybeStartNext();
        }
      });
    }
  };

  maybeStartNext();

  if (inFlight === 0 && head >= queue.length) {
    doneResolve?.();
  }

  try {
    await donePromise;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
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

export async function isProbablyBinary(
  filePath: string,
  existingHandle?: fs.FileHandle
): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();

  if (KNOWN_TEXT_EXTENSIONS.has(ext)) {
    return false;
  }
  if (KNOWN_BINARY_EXTENSIONS.has(ext)) {
    return true;
  }

  let handle = existingHandle;
  let shouldClose = false;
  let effectivePath = filePath;

  if (!handle) {
    effectivePath = await validateExistingPath(filePath);
    handle = await fs.open(effectivePath, 'r');
    shouldClose = true;
  }

  try {
    const buffer = Buffer.alloc(BINARY_CHECK_BUFFER_SIZE);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      BINARY_CHECK_BUFFER_SIZE,
      0
    );

    if (bytesRead === 0) {
      return false; // Empty file is considered text
    }

    const slice = buffer.subarray(0, bytesRead);

    if (
      bytesRead >= 3 &&
      slice[0] === 0xef &&
      slice[1] === 0xbb &&
      slice[2] === 0xbf
    ) {
      return false;
    }

    if (
      bytesRead >= 2 &&
      ((slice[0] === 0xff && slice[1] === 0xfe) ||
        (slice[0] === 0xfe && slice[1] === 0xff))
    ) {
      return false;
    }

    return slice.includes(0);
  } finally {
    if (shouldClose) {
      await handle.close().catch(() => {});
    }
  }
}

// Find UTF-8 character boundary by backtracking
async function findUTF8Boundary(
  handle: fs.FileHandle,
  position: number
): Promise<number> {
  if (position <= 0) return 0;

  const buf = Buffer.alloc(1);
  let currentPos = position;

  // Backtrack up to 4 bytes to find leading byte
  for (let i = 0; i < 4; i++) {
    // If we reached the beginning of the file, that's a boundary
    if (currentPos <= 0) return 0;

    try {
      await handle.read(buf, 0, 1, currentPos);
    } catch (error) {
      // On read error, return original position to avoid data corruption
      console.error(
        `[findUTF8Boundary] Read error at position ${currentPos}:`,
        error instanceof Error ? error.message : String(error)
      );
      return position;
    }

    // Check if byte is a leading byte
    const byte = buf[0];
    if (byte !== undefined && (byte & 0xc0) !== 0x80) {
      return currentPos;
    }
    currentPos--;
  }

  // If we backtracked 4 bytes and still found only continuation bytes,
  return position;
}

export async function tailFile(
  filePath: string,
  numLines: number
): Promise<string> {
  // Optimized chunk size reduces syscalls with minimal memory overhead
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
        // If we moved back, we need to read more
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

// Read specific line range from file using streaming
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

      // Check if there are more lines after the requested range
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

  // Check for mutually exclusive options
  const optionsCount = [lineRange, head, tail].filter(Boolean).length;
  if (optionsCount > 1) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Cannot specify multiple of lineRange, head, or tail simultaneously',
      filePath
    );
  }

  // Validate lineRange if provided
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

  // For line range, use streaming to avoid loading entire file into memory
  if (lineRange) {
    const result = await readLineRange(
      validPath,
      lineRange.start,
      lineRange.end
    );
    const expectedLines = lineRange.end - lineRange.start + 1;
    // truncated if: not starting at line 1, OR didn't get all requested lines, OR file has more lines
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

  return { path: validPath, content, truncated: false };
}

// Process items in parallel using the shared work queue
export async function processInParallel<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number = PARALLEL_CONCURRENCY
): Promise<ParallelResult<R>> {
  const results: R[] = [];
  const errors: { index: number; error: Error }[] = [];

  if (items.length === 0) {
    return { results, errors };
  }

  await runWorkQueue(
    items.map((item, index) => ({ item, index })),
    async ({ item, index }) => {
      try {
        const result = await processor(item);
        results.push(result);
      } catch (reason) {
        const error =
          reason instanceof Error ? reason : new Error(String(reason));
        errors.push({ index, error });
      }
    },
    concurrency
  );

  return { results, errors };
}
