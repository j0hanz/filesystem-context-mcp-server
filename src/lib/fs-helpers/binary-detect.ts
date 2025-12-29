import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  BINARY_CHECK_BUFFER_SIZE,
  KNOWN_BINARY_EXTENSIONS,
} from '../constants.js';
import { validateExistingPath } from '../path-validation.js';
import { withAbort } from './abort.js';

function hasKnownBinaryExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return KNOWN_BINARY_EXTENSIONS.has(ext);
}

async function withFileHandle<T>(
  filePath: string,
  fn: (handle: fs.FileHandle) => Promise<T>,
  existingHandle?: fs.FileHandle,
  signal?: AbortSignal
): Promise<T> {
  if (existingHandle) {
    return fn(existingHandle);
  }

  const effectivePath = await validateExistingPath(filePath, signal);
  const handle = await withAbort(fs.open(effectivePath, 'r'), signal);
  try {
    return await fn(handle);
  } finally {
    await handle.close().catch((error: unknown) => {
      console.error('Failed to close file handle:', error);
    });
  }
}

async function readProbe(
  handle: fs.FileHandle,
  signal?: AbortSignal
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(BINARY_CHECK_BUFFER_SIZE);
  const { bytesRead } = await withAbort(
    handle.read(buffer, 0, BINARY_CHECK_BUFFER_SIZE, 0),
    signal
  );

  if (bytesRead === 0) {
    return Buffer.alloc(0);
  }

  return buffer.subarray(0, bytesRead);
}

function hasUtf8Bom(slice: Buffer): boolean {
  return (
    slice.length >= 3 &&
    slice[0] === 0xef &&
    slice[1] === 0xbb &&
    slice[2] === 0xbf
  );
}

function hasUtf16Bom(slice: Buffer): boolean {
  return (
    slice.length >= 2 &&
    ((slice[0] === 0xff && slice[1] === 0xfe) ||
      (slice[0] === 0xfe && slice[1] === 0xff))
  );
}

export async function isProbablyBinary(
  filePath: string,
  existingHandle?: fs.FileHandle,
  signal?: AbortSignal
): Promise<boolean> {
  if (hasKnownBinaryExtension(filePath)) {
    return true;
  }

  return withFileHandle(
    filePath,
    async (handle) => {
      const slice = await readProbe(handle, signal);
      return isBinarySlice(slice);
    },
    existingHandle,
    signal
  );
}

function isBinarySlice(slice: Buffer): boolean {
  if (slice.length === 0) return false;
  if (hasUtf8Bom(slice) || hasUtf16Bom(slice)) return false;
  return slice.includes(0);
}
