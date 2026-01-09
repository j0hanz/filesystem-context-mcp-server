import { MAX_TEXT_FILE_SIZE } from '../../constants.js';

export type ReadMode = 'head' | 'full';

export interface ReadFileOptions {
  encoding?: BufferEncoding;
  maxSize?: number;
  head?: number;
  skipBinary?: boolean;
  signal?: AbortSignal;
}

export interface NormalizedOptions {
  encoding: BufferEncoding;
  maxSize: number;
  head?: number;
  skipBinary: boolean;
  signal?: AbortSignal;
}

export interface ReadFileResult {
  path: string;
  content: string;
  truncated: boolean;
  totalLines?: number;
  readMode: ReadMode;
  head?: number;
  linesRead?: number;
  hasMoreLines?: boolean;
}

export function normalizeOptions(options: ReadFileOptions): NormalizedOptions {
  const normalized: NormalizedOptions = {
    encoding: options.encoding ?? 'utf-8',
    maxSize: Math.min(
      options.maxSize ?? MAX_TEXT_FILE_SIZE,
      MAX_TEXT_FILE_SIZE
    ),
    skipBinary: options.skipBinary ?? false,
  };
  if (options.head !== undefined) {
    normalized.head = options.head;
  }
  if (options.signal) {
    normalized.signal = options.signal;
  }
  return normalized;
}

export function resolveReadMode(options: NormalizedOptions): ReadMode {
  if (options.head !== undefined) return 'head';
  return 'full';
}
