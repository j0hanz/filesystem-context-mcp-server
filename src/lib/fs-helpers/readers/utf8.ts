import type { FileHandle } from 'node:fs/promises';

import { withAbort } from '../abort.js';

export async function findUTF8Boundary(
  handle: FileHandle,
  position: number,
  signal?: AbortSignal
): Promise<number> {
  if (position <= 0) return 0;

  const backtrackSize = Math.min(4, position);
  const startPos = position - backtrackSize;
  const readResult = await readBacktrackBuffer(
    handle,
    backtrackSize,
    startPos,
    position,
    signal
  );
  if (!readResult) return position;

  const boundary = scanForBoundary(
    readResult.buffer,
    readResult.bytesRead,
    startPos
  );
  return boundary ?? position;
}

async function readBacktrackBuffer(
  handle: FileHandle,
  backtrackSize: number,
  startPos: number,
  position: number,
  signal?: AbortSignal
): Promise<{ buffer: Buffer; bytesRead: number } | null> {
  const buffer = Buffer.allocUnsafe(backtrackSize);
  try {
    const { bytesRead } = await withAbort(
      handle.read(buffer, 0, backtrackSize, startPos),
      signal
    );
    return { buffer, bytesRead };
  } catch (error) {
    console.error(
      `[findUTF8Boundary] Read error at position ${position}:`,
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

function scanForBoundary(
  buffer: Buffer,
  bytesRead: number,
  startPos: number
): number | null {
  for (let i = bytesRead - 1; i >= 0; i--) {
    const byte = buffer[i];
    if (byte !== undefined && (byte & 0xc0) !== 0x80) {
      return startPos + i;
    }
  }
  return null;
}
