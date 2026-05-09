import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';

import { assertNotAborted, withAbort } from './abort.js';

export async function atomicWriteFile(
  filePath: string,
  content: string,
  options: { encoding?: BufferEncoding; signal?: AbortSignal | undefined } = {},
): Promise<void> {
  const { encoding = 'utf-8', signal } = options;
  const tempPath = `${filePath}.${randomUUID()}.tmp`;

  try {
    assertNotAborted(signal);
    await writeFile(tempPath, content, { encoding, signal });
    await withAbort(rename(tempPath, filePath), signal);
  } catch (error) {
    try {
      await unlink(tempPath).catch(() => undefined);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}
