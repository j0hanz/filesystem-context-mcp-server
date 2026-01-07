import type { FileHandle } from 'node:fs/promises';
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
  #chunks: Buffer[] = [];
  #totalSize = 0;
  #maxSize: number;
  #requestedPath: string;

  constructor(maxSize: number, requestedPath: string) {
    super({ autoDestroy: true });
    this.#maxSize = maxSize;
    this.#requestedPath = requestedPath;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#totalSize += buffer.length;

    if (this.#totalSize > this.#maxSize) {
      callback(
        createTooLargeError(this.#totalSize, this.#maxSize, this.#requestedPath)
      );
      return;
    }

    this.#chunks.push(buffer);
    callback();
  }

  getResult(): Buffer {
    return Buffer.concat(this.#chunks, this.#totalSize);
  }
}

export async function readFileBufferWithLimit(
  handle: FileHandle,
  maxSize: number,
  requestedPath: string,
  signal?: AbortSignal
): Promise<Buffer> {
  const stream = handle.createReadStream({
    start: 0,
    highWaterMark: STREAM_CHUNK_SIZE,
    autoClose: false,
    emitClose: false,
  });
  const collector = new BufferCollector(maxSize, requestedPath);

  await pipeline(stream, collector, { signal });
  return collector.getResult();
}
