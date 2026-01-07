import type * as fs from 'node:fs/promises';

import { assertNotAborted, withAbort } from '../abort.js';
import { findUTF8Boundary } from './utf8.js';

interface TailReadState {
  position: number;
  bytesReadTotal: number;
  remainingText: string;
  linesFound: number;
  lines: string[];
}
interface TailReadWindow {
  startPos: number;
  size: number;
}
const CHUNK_SIZE = 256 * 1024;

function initTailState(fileSize: number): TailReadState {
  return {
    position: fileSize,
    bytesReadTotal: 0,
    remainingText: '',
    linesFound: 0,
    lines: [],
  };
}
function clampWindow(
  position: number,
  maxBytesRead: number | undefined,
  bytesReadTotal: number
): TailReadWindow | null {
  if (position <= 0) return null;

  let size = Math.min(CHUNK_SIZE, position);
  let startPos = position - size;

  if (maxBytesRead !== undefined) {
    const remainingBytes = maxBytesRead - bytesReadTotal;
    if (remainingBytes <= 0) return null;
    if (size > remainingBytes) {
      size = remainingBytes;
      startPos = position - size;
    }
  }

  return { startPos, size };
}

async function readAlignedChunk(
  handle: fs.FileHandle,
  aligned: TailReadWindow,
  encoding: BufferEncoding,
  signal?: AbortSignal
): Promise<{ data: string; bytesRead: number } | null> {
  // Use allocUnsafe since we immediately overwrite with file data
  const chunk = Buffer.allocUnsafe(aligned.size + 4);
  const { bytesRead } = await withAbort(
    handle.read(chunk, 0, aligned.size, aligned.startPos),
    signal
  );
  if (bytesRead === 0) return null;
  return {
    data: chunk.subarray(0, bytesRead).toString(encoding),
    bytesRead,
  };
}

async function resolveAlignedWindow(
  handle: fs.FileHandle,
  state: TailReadState,
  maxBytesRead: number | undefined,
  signal?: AbortSignal
): Promise<TailReadWindow | null> {
  const window = clampWindow(
    state.position,
    maxBytesRead,
    state.bytesReadTotal
  );
  if (!window) return null;
  if (window.startPos <= 0) return window;

  const alignedPos = await findUTF8Boundary(handle, window.startPos, signal);
  const alignedSize = state.position - alignedPos;

  if (
    maxBytesRead === undefined ||
    alignedSize <= maxBytesRead - state.bytesReadTotal
  ) {
    return { startPos: alignedPos, size: alignedSize };
  }

  return window;
}

function applyChunkLines(
  state: TailReadState,
  chunkText: string,
  numLines: number,
  hasMoreBefore: boolean
): void {
  const chunkLines = chunkText.replace(/\r\n/g, '\n').split('\n');
  state.remainingText = hasMoreBefore ? (chunkLines.shift() ?? '') : '';
  for (let i = chunkLines.length - 1; i >= 0; i--) {
    if (state.linesFound >= numLines) break;
    const line = chunkLines[i];
    if (line !== undefined) {
      state.lines.push(line);
      state.linesFound++;
    }
  }
}

async function readTailLoop(
  handle: fs.FileHandle,
  state: TailReadState,
  numLines: number,
  encoding: BufferEncoding,
  maxBytesRead: number | undefined,
  signal?: AbortSignal
): Promise<string> {
  while (state.position > 0 && state.linesFound < numLines) {
    assertNotAborted(signal);
    const aligned = await resolveAlignedWindow(
      handle,
      state,
      maxBytesRead,
      signal
    );
    if (!aligned) {
      state.position = 0;
      break;
    }
    state.position = aligned.startPos;
    const chunkResult = await readAlignedChunk(
      handle,
      aligned,
      encoding,
      signal
    );
    if (!chunkResult) {
      state.position = 0;
      break;
    }
    state.bytesReadTotal += chunkResult.bytesRead;
    applyChunkLines(
      state,
      chunkResult.data + state.remainingText,
      numLines,
      state.position > 0
    );
  }
  const reversed = [...state.lines].reverse();
  return reversed.join('\n');
}

export async function tailFile(
  handle: fs.FileHandle,
  fileSize: number,
  numLines: number,
  encoding: BufferEncoding = 'utf-8',
  maxBytesRead?: number,
  signal?: AbortSignal
): Promise<string> {
  assertNotAborted(signal);
  if (fileSize === 0) return '';

  const state = initTailState(fileSize);
  return await readTailLoop(
    handle,
    state,
    numLines,
    encoding,
    maxBytesRead,
    signal
  );
}
