import { createReadStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ErrorCode, McpError } from '../../errors.js';

const STREAM_CHUNK_SIZE = 64 * 1024;

function createTooLargeError(
  bytesRead: number,
  maxSize: number,
  requestedPath: string
): McpError {
  return new McpError(
    ErrorCode.E_TOO_LARGE,
    `File exceeds maximum size (${bytesRead} > ${maxSize}): ${requestedPath}`,
    requestedPath,
    { size: bytesRead, maxSize }
  );
}

class BufferCollector extends Writable {
  private chunks: Buffer[] = [];
  private totalSize = 0;

  constructor(
    private readonly maxSize: number,
    private readonly requestedPath: string
  ) {
    super({ autoDestroy: true });
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalSize += buffer.length;

    if (this.totalSize > this.maxSize) {
      callback(
        createTooLargeError(this.totalSize, this.maxSize, this.requestedPath)
      );
      return;
    }

    this.chunks.push(buffer);
    callback();
  }

  getResult(): Buffer {
    return Buffer.concat(this.chunks, this.totalSize);
  }
}

export async function readFileBufferWithLimit(
  filePath: string,
  maxSize: number,
  requestedPath: string = filePath,
  signal?: AbortSignal
): Promise<Buffer> {
  const stream = createReadStream(filePath, {
    highWaterMark: STREAM_CHUNK_SIZE,
  });
  const collector = new BufferCollector(maxSize, requestedPath);

  await pipeline(stream, collector, { signal });
  return collector.getResult();
}
