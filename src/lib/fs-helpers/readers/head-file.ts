import type * as fs from 'node:fs/promises';

import { assertNotAborted } from '../abort.js';

export async function headFile(
  handle: fs.FileHandle,
  numLines: number,
  encoding: BufferEncoding = 'utf-8',
  maxBytesRead?: number,
  signal?: AbortSignal
): Promise<string> {
  assertNotAborted(signal);

  const lines: string[] = [];
  let estimatedBytes = 0;
  const hasMaxBytes = maxBytesRead !== undefined;

  for await (const line of handle.readLines({ encoding, signal })) {
    lines.push(line);

    if (lines.length >= numLines) break;
    if (!hasMaxBytes) continue;

    // Estimate bytes read (line content + newline)
    // This is an approximation as readLines abstracts the actual buffering
    estimatedBytes += Buffer.byteLength(line, encoding) + 1;
    if (estimatedBytes >= maxBytesRead) break;
  }

  return lines.join('\n');
}
