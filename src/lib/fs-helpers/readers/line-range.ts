import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';

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

  if (maxBytesRead !== undefined && bytesRead > maxBytesRead) {
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
  getBytesRead: () => number
): Promise<void> {
  for await (const line of rl) {
    state.lineNumber++;

    if (state.lineNumber >= startLine && state.lineNumber <= endLine) {
      state.lines.push(line);
    }

    if (shouldStopLineRange(state, endLine, maxBytesRead, getBytesRead())) {
      break;
    }
  }
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
  maxBytesRead?: number
): Promise<LineRangeResult> {
  const fileStream = createReadStream(filePath, { encoding });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const state = initLineRangeState();

  try {
    await scanLineRange(
      rl,
      state,
      startLine,
      endLine,
      maxBytesRead,
      () => fileStream.bytesRead
    );
    return buildLineRangeResult(state);
  } finally {
    rl.close();
    fileStream.destroy();
  }
}
