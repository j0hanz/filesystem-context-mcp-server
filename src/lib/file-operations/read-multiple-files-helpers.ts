import type { Stats } from 'node:fs';

import { MAX_TEXT_FILE_SIZE, PARALLEL_CONCURRENCY } from '../constants.js';
import { processInParallel } from '../fs-helpers/concurrency.js';
import {
  readFile,
  readFileWithStats,
} from '../fs-helpers/readers/read-file.js';
import { assertLineRangeOptions } from '../line-range.js';

export interface ReadMultipleResult {
  path: string;
  content?: string;
  truncated?: boolean;
  totalLines?: number;
  readMode?: 'full' | 'head' | 'tail' | 'lineRange';
  lineStart?: number;
  lineEnd?: number;
  head?: number;
  tail?: number;
  linesRead?: number;
  hasMoreLines?: boolean;
  error?: string;
}

export interface NormalizedReadMultipleOptions {
  encoding: BufferEncoding;
  maxSize: number;
  maxTotalSize: number;
  lineRange?: { start: number; end: number };
  head?: number;
  tail?: number;
}

export interface ReadMultipleOptions {
  encoding?: BufferEncoding;
  maxSize?: number;
  maxTotalSize?: number;
  head?: number;
  tail?: number;
  lineStart?: number;
  lineEnd?: number;
  signal?: AbortSignal;
}

export interface FileReadTask {
  filePath: string;
  index: number;
  validPath?: string;
  stats?: Stats;
}

function buildReadOptions(options: NormalizedReadMultipleOptions): {
  encoding: BufferEncoding;
  maxSize: number;
  head?: number;
  tail?: number;
  lineRange?: { start: number; end: number };
} {
  return {
    encoding: options.encoding,
    maxSize: options.maxSize,
    head: options.head,
    tail: options.tail,
    lineRange: options.lineRange,
  };
}

async function readSingleFile(
  task: FileReadTask,
  options: NormalizedReadMultipleOptions,
  signal?: AbortSignal
): Promise<{ index: number; value: ReadMultipleResult }> {
  const { filePath, index, validPath, stats } = task;
  const readOptions = { ...buildReadOptions(options), signal };
  const result =
    validPath && stats
      ? await readFileWithStats(filePath, validPath, stats, readOptions)
      : await readFile(filePath, readOptions);

  return {
    index,
    value: {
      path: filePath,
      content: result.content,
      truncated: result.truncated,
      totalLines: result.totalLines,
      readMode: result.readMode,
      lineStart: result.lineStart,
      lineEnd: result.lineEnd,
      head: result.head,
      tail: result.tail,
      linesRead: result.linesRead,
      hasMoreLines: result.hasMoreLines,
    },
  };
}

export function isPartialRead(options: NormalizedReadMultipleOptions): boolean {
  return (
    options.lineRange !== undefined ||
    options.head !== undefined ||
    options.tail !== undefined
  );
}

export async function readFilesInParallel(
  filesToProcess: FileReadTask[],
  options: NormalizedReadMultipleOptions,
  signal?: AbortSignal
): Promise<{
  results: { index: number; value: ReadMultipleResult }[];
  errors: { index: number; error: Error }[];
}> {
  return await processInParallel(
    filesToProcess,
    async (task) => readSingleFile(task, options, signal),
    PARALLEL_CONCURRENCY,
    signal
  );
}

function normalizeReadMultipleOptions(
  options: ReadMultipleOptions,
  pathLabel: string
): NormalizedReadMultipleOptions {
  assertLineRangeOptions(
    {
      lineStart: options.lineStart,
      lineEnd: options.lineEnd,
      head: options.head,
      tail: options.tail,
    },
    pathLabel
  );
  const lineRange =
    options.lineStart !== undefined && options.lineEnd !== undefined
      ? { start: options.lineStart, end: options.lineEnd }
      : undefined;
  return {
    encoding: options.encoding ?? 'utf-8',
    maxSize: Math.min(
      options.maxSize ?? MAX_TEXT_FILE_SIZE,
      MAX_TEXT_FILE_SIZE
    ),
    maxTotalSize: options.maxTotalSize ?? 100 * 1024 * 1024,
    lineRange,
    head: options.head,
    tail: options.tail,
  };
}

export function resolveNormalizedOptions(
  filePaths: readonly string[],
  options: ReadMultipleOptions
): { normalized: NormalizedReadMultipleOptions; signal?: AbortSignal } {
  const pathLabel = filePaths[0] ?? '<paths>';
  const { signal, ...rest } = options;
  return {
    normalized: normalizeReadMultipleOptions(rest, pathLabel),
    signal,
  };
}
