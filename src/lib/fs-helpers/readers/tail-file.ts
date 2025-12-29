import * as fs from 'node:fs/promises';

import { validateExistingPath } from '../../path-validation.js';
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

function shouldContinue(state: TailReadState, numLines: number): boolean {
  return state.position > 0 && state.linesFound < numLines;
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

async function alignWindow(
  handle: fs.FileHandle,
  window: TailReadWindow,
  position: number,
  maxBytesRead: number | undefined,
  bytesReadTotal: number,
  signal?: AbortSignal
): Promise<TailReadWindow> {
  if (window.startPos <= 0) return window;

  const alignedPos = await findUTF8Boundary(handle, window.startPos, signal);
  const alignedSize = position - alignedPos;

  if (
    maxBytesRead === undefined ||
    alignedSize <= maxBytesRead - bytesReadTotal
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
  const chunkLines = splitChunkLines(chunkText);
  const lines = updateRemainingText(state, chunkLines, hasMoreBefore);
  appendLinesFromEnd(state, lines, numLines);
}

function splitChunkLines(chunkText: string): string[] {
  return chunkText.replace(/\r\n/g, '\n').split('\n');
}

function updateRemainingText(
  state: TailReadState,
  chunkLines: string[],
  hasMoreBefore: boolean
): string[] {
  if (hasMoreBefore) {
    state.remainingText = chunkLines.shift() ?? '';
    return chunkLines;
  }
  state.remainingText = '';
  return chunkLines;
}

function appendLinesFromEnd(
  state: TailReadState,
  chunkLines: string[],
  numLines: number
): void {
  for (let i = chunkLines.length - 1; i >= 0; i--) {
    if (state.linesFound >= numLines) break;
    const line = chunkLines[i];
    if (line !== undefined) {
      state.lines.push(line);
      state.linesFound++;
    }
  }
}

async function readAlignedChunk(
  handle: fs.FileHandle,
  aligned: TailReadWindow,
  encoding: BufferEncoding,
  signal?: AbortSignal
): Promise<{ data: string; bytesRead: number } | null> {
  const chunk = Buffer.alloc(aligned.size + 4);
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

async function readTailChunk(
  handle: fs.FileHandle,
  state: TailReadState,
  numLines: number,
  encoding: BufferEncoding,
  maxBytesRead: number | undefined,
  signal?: AbortSignal
): Promise<void> {
  assertNotAborted(signal);
  const window = clampWindow(
    state.position,
    maxBytesRead,
    state.bytesReadTotal
  );
  if (!window) {
    state.position = 0;
    return;
  }

  const aligned = await alignWindow(
    handle,
    window,
    state.position,
    maxBytesRead,
    state.bytesReadTotal,
    signal
  );

  state.position = aligned.startPos;
  const chunkResult = await readAlignedChunk(handle, aligned, encoding, signal);
  if (!chunkResult) {
    state.position = 0;
    return;
  }

  state.bytesReadTotal += chunkResult.bytesRead;
  const combined = chunkResult.data + state.remainingText;
  applyChunkLines(state, combined, numLines, state.position > 0);
}

export async function tailFile(
  filePath: string,
  numLines: number,
  encoding: BufferEncoding = 'utf-8',
  maxBytesRead?: number,
  signal?: AbortSignal
): Promise<string> {
  assertNotAborted(signal);
  const validPath = await validateExistingPath(filePath, signal);
  const stats = await withAbort(fs.stat(validPath), signal);
  if (stats.size === 0) return '';

  const handle = await withAbort(fs.open(validPath, 'r'), signal);
  try {
    const state = initTailState(stats.size);

    while (shouldContinue(state, numLines)) {
      await readTailChunk(
        handle,
        state,
        numLines,
        encoding,
        maxBytesRead,
        signal
      );
    }

    return state.lines.reverse().join('\n');
  } finally {
    await handle.close();
  }
}
