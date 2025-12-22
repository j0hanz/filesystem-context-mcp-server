import type { FileHandle } from 'node:fs/promises';

export async function findUTF8Boundary(
  handle: FileHandle,
  position: number
): Promise<number> {
  if (position <= 0) return 0;

  const backtrackSize = Math.min(4, position);
  const startPos = position - backtrackSize;
  const readResult = await readBacktrackBuffer(
    handle,
    backtrackSize,
    startPos,
    position
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
  position: number
): Promise<{ buffer: Buffer; bytesRead: number } | null> {
  const buffer = Buffer.allocUnsafe(backtrackSize);
  try {
    const { bytesRead } = await handle.read(buffer, 0, backtrackSize, startPos);
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
