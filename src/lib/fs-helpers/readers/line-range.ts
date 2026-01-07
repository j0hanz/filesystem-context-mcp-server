import * as readline from 'node:readline';
import type { ReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import { assertNotAborted } from '../abort.js';

interface LineRangeState {
  lines: string[];
  lineNumber: number;
  hasMoreLines: boolean;
}

interface LineRangeResult {
  content: string;
  linesRead: number;
  hasMoreLines: boolean;
}

function initLineRangeState(): LineRangeState {
  return { lines: [], lineNumber: 0, hasMoreLines: false };
}

function shouldStopLineRange(
  state: LineRangeState,
  endLine: number,
  maxBytesRead: number | undefined,
  bytesRead: number
): boolean {
  if (state.lineNumber > endLine) {
    state.hasMoreLines = true;
    return true;
  }

  if (maxBytesRead !== undefined && bytesRead >= maxBytesRead) {
    state.hasMoreLines = true;
    return true;
  }

  return false;
}

async function scanLineRange(
  rl: readline.Interface,
  state: LineRangeState,
  startLine: number,
  endLine: number,
  maxBytesRead: number | undefined,
  getBytesRead: () => number,
  signal?: AbortSignal
): Promise<void> {
  for await (const line of rl) {
    if (signal?.aborted) break;
    state.lineNumber++;

    recordLineIfInRange(state, line, startLine, endLine);

    if (shouldStopLineRange(state, endLine, maxBytesRead, getBytesRead())) {
      break;
    }
  }
}

function shouldCaptureLine(
  lineNumber: number,
  startLine: number,
  endLine: number
): boolean {
  return lineNumber >= startLine && lineNumber <= endLine;
}

function recordLineIfInRange(
  state: LineRangeState,
  line: string,
  startLine: number,
  endLine: number
): void {
  if (!shouldCaptureLine(state.lineNumber, startLine, endLine)) return;
  state.lines.push(line);
}

function buildLineRangeResult(state: LineRangeState): LineRangeResult {
  return {
    content: state.lines.join('\n'),
    linesRead: state.lines.length,
    hasMoreLines: state.hasMoreLines,
  };
}

function setupAbortHandler(
  fileStream: ReadStream,
  signal?: AbortSignal
): () => void {
  const onAbort = (): void => {
    fileStream.destroy(new Error('Operation aborted'));
  };

  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener('abort', onAbort);
  }

  return (): void => {
    signal?.removeEventListener('abort', onAbort);
  };
}

function createLineRangeReader(
  handle: FileHandle,
  encoding: BufferEncoding,
  signal?: AbortSignal
): {
  fileStream: ReadStream;
  rl: readline.Interface;
  cleanup: () => void;
} {
  const fileStream = handle.createReadStream({
    encoding,
    autoClose: false,
    emitClose: false,
  });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });
  const abortCleanup = setupAbortHandler(fileStream, signal);
  const cleanup = (): void => {
    abortCleanup();
    rl.close();
  };

  return { fileStream, rl, cleanup };
}

export async function readLineRange(
  handle: FileHandle,
  startLine: number,
  endLine: number,
  encoding: BufferEncoding,
  maxBytesRead?: number,
  signal?: AbortSignal
): Promise<LineRangeResult> {
  assertNotAborted(signal);
  const { fileStream, rl, cleanup } = createLineRangeReader(
    handle,
    encoding,
    signal
  );
  const state = initLineRangeState();

  try {
    await scanLineRange(
      rl,
      state,
      startLine,
      endLine,
      maxBytesRead,
      () => fileStream.bytesRead,
      signal
    );
    return buildLineRangeResult(state);
  } finally {
    cleanup();
  }
}
