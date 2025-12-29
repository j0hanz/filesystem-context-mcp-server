import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';

import { assertNotAborted, createAbortError } from '../abort.js';

interface LineRangeState {
  lines: string[];
  lineNumber: number;
  hasMoreLines: boolean;
}

interface LineRangeResult {
  content: string;
  linesRead: number;
  totalLinesScanned: number;
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
    totalLinesScanned: state.lineNumber,
    hasMoreLines: state.hasMoreLines,
  };
}

export async function readLineRange(
  filePath: string,
  startLine: number,
  endLine: number,
  encoding: BufferEncoding,
  maxBytesRead?: number,
  signal?: AbortSignal
): Promise<LineRangeResult> {
  assertNotAborted(signal);
  const fileStream = createReadStream(filePath, { encoding });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const state = initLineRangeState();
  const onAbort = (): void => {
    fileStream.destroy(createAbortError());
  };
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
  }

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
    signal?.removeEventListener('abort', onAbort);
    rl.close();
    fileStream.destroy();
  }
}
