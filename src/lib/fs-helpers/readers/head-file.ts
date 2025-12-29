import * as fs from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

import { validateExistingPath } from '../../path-validation.js';
import { assertNotAborted, withAbort } from '../abort.js';

interface HeadReadState {
  lines: string[];
  bytesRead: number;
  buffer: string;
  decoder: StringDecoder;
}

const CHUNK_SIZE = 64 * 1024;

function initHeadState(encoding: BufferEncoding): HeadReadState {
  return {
    lines: [],
    bytesRead: 0,
    buffer: '',
    decoder: new StringDecoder(encoding),
  };
}

function maxChunkSize(
  maxBytesRead: number | undefined,
  bytesRead: number
): number {
  if (maxBytesRead === undefined) return CHUNK_SIZE;
  return Math.min(CHUNK_SIZE, maxBytesRead - bytesRead);
}

function appendBufferLines(state: HeadReadState, numLines: number): void {
  const normalizedBuffer = state.buffer.replace(/\r\n/g, '\n');
  const newLineIndex = normalizedBuffer.lastIndexOf('\n');
  if (newLineIndex === -1) {
    state.buffer = normalizedBuffer;
    return;
  }

  const completeLines = normalizedBuffer.substring(0, newLineIndex).split('\n');
  state.buffer = normalizedBuffer.substring(newLineIndex + 1);

  for (const line of completeLines) {
    state.lines.push(line);
    if (state.lines.length >= numLines) break;
  }
}

function flushRemainingBuffer(state: HeadReadState, numLines: number): void {
  if (state.lines.length >= numLines) return;
  if (state.buffer.length === 0) return;

  const remainingLines = state.buffer.replace(/\r\n/g, '\n').split('\n');
  for (const line of remainingLines) {
    state.lines.push(line);
    if (state.lines.length >= numLines) break;
  }
}

async function readHeadChunks(
  handle: fs.FileHandle,
  state: HeadReadState,
  numLines: number,
  maxBytesRead: number | undefined,
  signal?: AbortSignal
): Promise<void> {
  const chunk = Buffer.alloc(CHUNK_SIZE);

  while (state.lines.length < numLines) {
    assertNotAborted(signal);
    if (maxBytesRead !== undefined && state.bytesRead >= maxBytesRead) break;

    const maxChunk = maxChunkSize(maxBytesRead, state.bytesRead);
    const result = await withAbort(
      handle.read(chunk, 0, maxChunk, state.bytesRead),
      signal
    );
    if (result.bytesRead === 0) break;

    state.bytesRead += result.bytesRead;
    state.buffer += state.decoder.write(chunk.subarray(0, result.bytesRead));
    appendBufferLines(state, numLines);
  }

  state.buffer += state.decoder.end();
  flushRemainingBuffer(state, numLines);
}

export async function headFile(
  filePath: string,
  numLines: number,
  encoding: BufferEncoding = 'utf-8',
  maxBytesRead?: number,
  signal?: AbortSignal
): Promise<string> {
  assertNotAborted(signal);
  const validPath = await validateExistingPath(filePath, signal);
  const handle = await withAbort(fs.open(validPath, 'r'), signal);

  try {
    const state = initHeadState(encoding);
    await readHeadChunks(handle, state, numLines, maxBytesRead, signal);
    return state.lines.slice(0, numLines).join('\n');
  } finally {
    await handle.close();
  }
}
