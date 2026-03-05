import * as fsp from 'node:fs/promises';
import type { Stats } from 'node:fs';

import {
  DEFAULT_READ_MANY_MAX_TOTAL_SIZE,
  MAX_TEXT_FILE_SIZE,
  PARALLEL_CONCURRENCY,
} from '../constants.js';
import {
  processInParallel,
  readFile,
  readFileWithStats,
  withAbort,
} from '../fs-helpers.js';
import { validateExistingPath } from '../paths.js';
import { applyIndexedErrors, applyIndexedValues } from './common.js';

interface ReadMultipleResult {
  path: string;
  content?: string;
  truncated?: boolean;
  totalLines?: number;
  readMode?: 'full' | 'head' | 'range';
  head?: number;
  startLine?: number;
  endLine?: number;
  linesRead?: number;
  hasMoreLines?: boolean;
  error?: string;
}

interface NormalizedReadMultipleOptions {
  encoding: BufferEncoding;
  maxSize: number;
  maxTotalSize: number;
  head?: number;
  startLine?: number;
  endLine?: number;
}

interface ReadMultipleOptions {
  encoding?: BufferEncoding;
  maxSize?: number;
  maxTotalSize?: number;
  head?: number;
  startLine?: number;
  endLine?: number;
  signal?: AbortSignal;
  onReadComplete?: () => void;
}

interface FileReadTask {
  filePath: string;
  index: number;
  validPath?: string;
  stats?: Stats;
}

interface LineSelectionOptions {
  head?: number;
  startLine?: number;
  endLine?: number;
}

const UNKNOWN_PATH = '(unknown)';

function estimateReadSize(stats: Stats, maxSize: number): number {
  // `readFile`/`readFileWithStats` are always invoked with a `maxSize` cap, so the
  // combined budget should reflect the maximum number of bytes we might actually read.
  return Math.min(stats.size, maxSize);
}

function buildReadOptions(options: NormalizedReadMultipleOptions): {
  encoding: BufferEncoding;
  maxSize: number;
  head?: number;
  startLine?: number;
  endLine?: number;
} {
  const readOptions: {
    encoding: BufferEncoding;
    maxSize: number;
    head?: number;
    startLine?: number;
    endLine?: number;
  } = {
    encoding: options.encoding,
    maxSize: options.maxSize,
  };
  applyLineSelection(readOptions, options);
  return readOptions;
}

function buildReadMultipleResult(
  filePath: string,
  result: Awaited<ReturnType<typeof readFile>>
): ReadMultipleResult {
  const output: ReadMultipleResult = {
    path: filePath,
    content: result.content,
    truncated: result.truncated,
    readMode: result.readMode,
  };
  if (result.totalLines !== undefined) output.totalLines = result.totalLines;
  if (result.head !== undefined) output.head = result.head;
  if (result.startLine !== undefined) output.startLine = result.startLine;
  if (result.endLine !== undefined) output.endLine = result.endLine;
  if (result.linesRead !== undefined) output.linesRead = result.linesRead;
  if (result.hasMoreLines !== undefined) {
    output.hasMoreLines = result.hasMoreLines;
  }
  return output;
}

async function readSingleFile(
  task: FileReadTask,
  readOptions: Parameters<typeof readFile>[1]
): Promise<{ index: number; value: ReadMultipleResult }> {
  const { filePath, index, validPath, stats } = task;
  const result =
    validPath && stats
      ? await readFileWithStats(filePath, validPath, stats, readOptions)
      : await readFile(filePath, readOptions);

  return {
    index,
    value: buildReadMultipleResult(filePath, result),
  };
}

async function readFilesInParallel(
  filesToProcess: FileReadTask[],
  options: NormalizedReadMultipleOptions,
  signal?: AbortSignal,
  onReadComplete?: () => void
): Promise<{
  results: { index: number; value: ReadMultipleResult }[];
  errors: { index: number; error: Error }[];
}> {
  const readOptions: Parameters<typeof readFile>[1] = buildReadOptions(options);
  if (signal) {
    readOptions.signal = signal;
  }
  return processInParallel(
    filesToProcess,
    async (task) => {
      const result = await readSingleFile(task, readOptions);
      onReadComplete?.();
      return result;
    },
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
    maxTotalSize: options.maxTotalSize ?? DEFAULT_READ_MANY_MAX_TOTAL_SIZE,
  };
  applyLineSelection(normalized, options);
  return normalized;
}

function applyLineSelection(
  target: LineSelectionOptions,
  source: LineSelectionOptions
): void {
  if (source.head !== undefined) target.head = source.head;
  if (source.startLine !== undefined) target.startLine = source.startLine;
  if (source.endLine !== undefined) target.endLine = source.endLine;
}

function resolveNormalizedOptions(options: ReadMultipleOptions): {
  normalized: NormalizedReadMultipleOptions;
  signal?: AbortSignal;
} {
  const { signal, ...rest } = options;
  return {
    normalized: normalizeReadMultipleOptions(rest),
    ...(signal ? { signal } : {}),
  };
}

interface ValidatedFileInfo {
  index: number;
  filePath: string;
  validPath: string;
  stats: Stats;
}

async function validateFile(
  filePath: string,
  index: number,
  signal?: AbortSignal
): Promise<ValidatedFileInfo> {
  const validPath = await validateExistingPath(filePath, signal);
  const stats = await withAbort(fsp.stat(validPath), signal);
  return { filePath, index, validPath, stats };
}

function markRemainingSkipped(
  startIndex: number,
  total: number,
  skippedBudget: Set<number>
): void {
  for (let index = startIndex; index < total; index += 1) {
    skippedBudget.add(index);
  }
}

async function tryValidateFile(
  filePath: string,
  index: number,
  signal?: AbortSignal
): Promise<ValidatedFileInfo | undefined> {
  try {
    return await validateFile(filePath, index, signal);
  } catch {
    return undefined;
  }
}

async function validateBatch(
  tasks: { filePath: string; index: number }[],
  signal?: AbortSignal
): Promise<Map<number, ValidatedFileInfo>> {
  if (tasks.length === 0) return new Map<number, ValidatedFileInfo>();

  const { results } = await processInParallel(
    tasks,
    async (task) => tryValidateFile(task.filePath, task.index, signal),
    PARALLEL_CONCURRENCY,
    signal
  );

  const infos = new Map<number, ValidatedFileInfo>();
  for (const info of results) {
    if (!info) continue;
    infos.set(info.index, info);
  }
  return infos;
}

function applyBudgetForRange(options: {
  batchStart: number;
  batchEnd: number;
  totalFiles: number;
  maxTotalSize: number;
  maxSize: number;
  validated: Map<number, ValidatedFileInfo>;
  skippedBudget: Set<number>;
  totalSize: number;
}): { totalSize: number; exceeded: boolean } {
  const {
    batchStart,
    batchEnd,
    totalFiles,
    maxTotalSize,
    maxSize,
    validated,
    skippedBudget,
    totalSize: startingTotalSize,
  } = options;
  let totalSize = startingTotalSize;

  for (let index = batchStart; index < batchEnd; index += 1) {
    const info = validated.get(index);
    if (!info) continue;

    const { exceeded, totalSize: nextTotalSize } = applyBudget(
      totalSize,
      estimateReadSize(info.stats, maxSize),
      maxTotalSize,
      index,
      totalFiles,
      skippedBudget
    );
    if (exceeded) {
      return { totalSize, exceeded: true };
    }
    totalSize = nextTotalSize;
  }

  return { totalSize, exceeded: false };
}

async function collectFileBudget(
  filePaths: readonly string[],
  maxTotalSize: number,
  maxSize: number,
  signal?: AbortSignal
): Promise<{
  skippedBudget: Set<number>;
  validated: Map<number, ValidatedFileInfo>;
}> {
  const skippedBudget = new Set<number>();
  const validated = new Map<number, ValidatedFileInfo>();
  let totalSize = 0;
  const totalFiles = filePaths.length;

  for (
    let batchStart = 0;
    batchStart < totalFiles;
    batchStart += PARALLEL_CONCURRENCY
  ) {
    const batchTasks: { filePath: string; index: number }[] = [];
    const batchEnd = Math.min(batchStart + PARALLEL_CONCURRENCY, totalFiles);

    for (let index = batchStart; index < batchEnd; index += 1) {
      const filePath = filePaths[index];
      if (!filePath) continue;
      if (validated.has(index)) continue;
      batchTasks.push({ filePath, index });
    }

    const batchInfos = await validateBatch(batchTasks, signal);
    for (const [index, info] of batchInfos) {
      validated.set(index, info);
    }

    const budgetResult = applyBudgetForRange({
      batchStart,
      batchEnd,
      totalFiles,
      maxTotalSize,
      maxSize,
      validated,
      skippedBudget,
      totalSize,
    });

    const { exceeded, totalSize: nextTotalSize } = budgetResult;
    if (exceeded) {
      return { skippedBudget, validated };
    }
    totalSize = nextTotalSize;
  }

  return { skippedBudget, validated };
}

function buildOutput(filePaths: readonly string[]): ReadMultipleResult[] {
  const output = new Array<ReadMultipleResult>(filePaths.length);
  for (let index = 0; index < filePaths.length; index += 1) {
    output[index] = { path: filePaths[index] ?? UNKNOWN_PATH };
  }
  return output;
}

function resolveErrorOriginalIndex(
  failureIndex: number,
  filesToProcess: { index: number }[],
  totalInputFiles: number
): number | undefined {
  // processInParallel implementations vary: some return error indices relative to
  // the submitted batch (filesToProcess), others may forward the task/index.
  const batchIndex = filesToProcess[failureIndex]?.index;
  if (
    typeof batchIndex === 'number' &&
    batchIndex >= 0 &&
    batchIndex < totalInputFiles
  ) {
    return batchIndex;
  }
  if (failureIndex >= 0 && failureIndex < totalInputFiles) {
    return failureIndex;
  }
  return undefined;
}

function buildFilesToProcess(
  filePaths: readonly string[],
  validated: Map<
    number,
    {
      validPath: string;
      stats: Stats;
    }
  >,
  skippedBudget: Set<number>
): FileReadTask[] {
  const filesToProcess: FileReadTask[] = [];
  for (let index = 0; index < filePaths.length; index += 1) {
    if (skippedBudget.has(index)) continue;
    const filePath = filePaths[index];
    if (!filePath) continue;
    const cached = validated.get(index);
    if (cached) {
      filesToProcess.push({
        filePath,
        index,
        validPath: cached.validPath,
        stats: cached.stats,
      });
      continue;
    }
    filesToProcess.push({ filePath, index });
  }
  return filesToProcess;
}

function applyBudget(
  totalSize: number,
  estimatedSize: number,
  maxTotalSize: number,
  index: number,
  totalFiles: number,
  skippedBudget: Set<number>
): { totalSize: number; exceeded: boolean } {
  if (totalSize + estimatedSize > maxTotalSize) {
    skippedBudget.add(index);
    markRemainingSkipped(index + 1, totalFiles, skippedBudget);
    return { totalSize, exceeded: true };
  }
  return { totalSize: totalSize + estimatedSize, exceeded: false };
}

function applySkippedBudget(
  output: ReadMultipleResult[],
  skippedBudget: Set<number>,
  filePaths: readonly string[],
  maxTotalSize: number
): void {
  for (const index of skippedBudget) {
    const filePath = filePaths[index];
    if (!filePath) continue;
    output[index] = {
      path: filePath,
      error: `Skipped: combined estimated read would exceed maxTotalSize (${maxTotalSize} bytes)`,
    };
  }
}

export async function readMultipleFiles(
  filePaths: readonly string[],
  options: ReadMultipleOptions = {}
): Promise<ReadMultipleResult[]> {
  if (filePaths.length === 0) return [];

  const { normalized, signal } = resolveNormalizedOptions(options);

  const output = buildOutput(filePaths);
  const { skippedBudget, validated } = await collectFileBudget(
    filePaths,
    normalized.maxTotalSize,
    normalized.maxSize,
    signal
  );

  const filesToProcess = buildFilesToProcess(
    filePaths,
    validated,
    skippedBudget
  );

  const { results, errors } = await readFilesInParallel(
    filesToProcess,
    normalized,
    signal,
    options.onReadComplete
  );

  applyIndexedValues(output, results);
  applyIndexedErrors({
    output,
    errors,
    resolveIndex: (failureIndex) =>
      resolveErrorOriginalIndex(failureIndex, filesToProcess, filePaths.length),
    buildValue: (resolvedIndex, error) => ({
      path: filePaths[resolvedIndex] ?? UNKNOWN_PATH,
      error: error.message,
    }),
  });
  applySkippedBudget(output, skippedBudget, filePaths, normalized.maxTotalSize);

  return output;
}
