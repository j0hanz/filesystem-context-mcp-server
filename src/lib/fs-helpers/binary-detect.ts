import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  BINARY_CHECK_BUFFER_SIZE,
  KNOWN_BINARY_EXTENSIONS,
} from '../constants.js';
import { validateExistingPath } from '../path-validation.js';

export async function isProbablyBinary(
  filePath: string,
  existingHandle?: fs.FileHandle
): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();

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
    const buffer = Buffer.allocUnsafe(BINARY_CHECK_BUFFER_SIZE);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      BINARY_CHECK_BUFFER_SIZE,
      0
    );

    if (bytesRead === 0) {
      return false;
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
