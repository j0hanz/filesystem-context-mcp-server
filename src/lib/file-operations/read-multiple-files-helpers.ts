import type { Stats } from 'node:fs';

import { MAX_TEXT_FILE_SIZE, PARALLEL_CONCURRENCY } from '../constants.js';
import { processInParallel } from '../fs-helpers/concurrency.js';
import {
  readFile,
  readFileWithStats,
} from '../fs-helpers/readers/read-file.js';

export interface ReadMultipleResult {
  path: string;
  content?: string;
  truncated?: boolean;
  totalLines?: number;
  readMode?: 'full' | 'head';
  head?: number;
  linesRead?: number;
  hasMoreLines?: boolean;
  error?: string;
}

export interface NormalizedReadMultipleOptions {
  encoding: BufferEncoding;
  maxSize: number;
  maxTotalSize: number;
  head?: number;
}

export interface ReadMultipleOptions {
  encoding?: BufferEncoding;
  maxSize?: number;
  maxTotalSize?: number;
  head?: number;
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
} {
  const readOptions: {
    encoding: BufferEncoding;
    maxSize: number;
    head?: number;
  } = {
    encoding: options.encoding,
    maxSize: options.maxSize,
  };
  if (options.head !== undefined) {
    readOptions.head = options.head;
  }
  return readOptions;
}

function buildReadMultipleResult(
  filePath: string,
  result: Awaited<ReturnType<typeof readFile>>
): ReadMultipleResult {
  const value: ReadMultipleResult = {
    path: filePath,
    content: result.content,
    truncated: result.truncated,
    readMode: result.readMode,
  };
  if (result.totalLines !== undefined) value.totalLines = result.totalLines;
  if (result.head !== undefined) value.head = result.head;
  if (result.linesRead !== undefined) value.linesRead = result.linesRead;
  if (result.hasMoreLines !== undefined) {
    value.hasMoreLines = result.hasMoreLines;
  }
  return value;
}

async function readSingleFile(
  task: FileReadTask,
  options: NormalizedReadMultipleOptions,
  signal?: AbortSignal
): Promise<{ index: number; value: ReadMultipleResult }> {
  const { filePath, index, validPath, stats } = task;
  const readOptions: Parameters<typeof readFile>[1] = {
    ...buildReadOptions(options),
  };
  if (signal) {
    readOptions.signal = signal;
  }
  const result =
    validPath && stats
      ? await readFileWithStats(filePath, validPath, stats, readOptions)
      : await readFile(filePath, readOptions);

  return {
    index,
    value: buildReadMultipleResult(filePath, result),
  };
}

export function isPartialRead(options: NormalizedReadMultipleOptions): boolean {
  return options.head !== undefined;
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
  options: ReadMultipleOptions
): NormalizedReadMultipleOptions {
  const normalized: NormalizedReadMultipleOptions = {
    encoding: options.encoding ?? 'utf-8',
    maxSize: Math.min(
      options.maxSize ?? MAX_TEXT_FILE_SIZE,
      MAX_TEXT_FILE_SIZE
    ),
    maxTotalSize: options.maxTotalSize ?? 100 * 1024 * 1024,
  };
  if (options.head !== undefined) {
    normalized.head = options.head;
  }
  return normalized;
}

export function resolveNormalizedOptions(
  _filePaths: readonly string[],
  options: ReadMultipleOptions
): { normalized: NormalizedReadMultipleOptions; signal?: AbortSignal } {
  const { signal, ...rest } = options;
  const resolved: {
    normalized: NormalizedReadMultipleOptions;
    signal?: AbortSignal;
  } = { normalized: normalizeReadMultipleOptions(rest) };
  if (signal) {
    resolved.signal = signal;
  }
  return resolved;
}
