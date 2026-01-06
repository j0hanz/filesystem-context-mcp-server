import { MAX_TEXT_FILE_SIZE } from '../../constants.js';

export type ReadMode = 'lineRange' | 'tail' | 'head' | 'full';

export interface ReadFileOptions {
  encoding?: BufferEncoding;
  maxSize?: number;
  lineRange?: { start: number; end: number };
  head?: number;
  tail?: number;
  skipBinary?: boolean;
  signal?: AbortSignal;
}

export interface NormalizedOptions {
  encoding: BufferEncoding;
  maxSize: number;
  lineRange?: { start: number; end: number };
  head?: number;
  tail?: number;
  skipBinary: boolean;
  signal?: AbortSignal;
}

export interface ReadFileResult {
  path: string;
  content: string;
  truncated: boolean;
  totalLines?: number;
  readMode: ReadMode;
  lineStart?: number;
  lineEnd?: number;
  head?: number;
  tail?: number;
  linesRead?: number;
  hasMoreLines?: boolean;
}

export function normalizeOptions(options: ReadFileOptions): NormalizedOptions {
  return {
    encoding: options.encoding ?? 'utf-8',
    maxSize: Math.min(
      options.maxSize ?? MAX_TEXT_FILE_SIZE,
      MAX_TEXT_FILE_SIZE
    ),
    lineRange: options.lineRange,
    head: options.head,
    tail: options.tail,
    skipBinary: options.skipBinary ?? false,
    signal: options.signal,
  };
}

export function resolveReadMode(options: NormalizedOptions): ReadMode {
  if (options.lineRange) return 'lineRange';
  if (options.tail !== undefined) return 'tail';
  if (options.head !== undefined) return 'head';
  return 'full';
}
