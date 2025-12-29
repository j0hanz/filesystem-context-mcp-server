import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';

import { PARALLEL_CONCURRENCY } from '../constants.js';
import {
  processInParallel,
  readFile,
  readFileWithStats,
} from '../fs-helpers.js';
import { withAbort } from '../fs-helpers/abort.js';
import { validateExistingPath } from '../path-validation.js';

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

export interface ValidatedFileInfo {
  index: number;
  filePath: string;
  validPath: string;
  stats: Stats;
}

export interface NormalizedReadMultipleOptions {
  encoding: BufferEncoding;
  maxSize: number;
  maxTotalSize: number;
  lineRange?: { start: number; end: number };
  head?: number;
  tail?: number;
}

export function createOutputSkeleton(
  filePaths: string[]
): ReadMultipleResult[] {
  return filePaths.map((filePath) => ({ path: filePath }));
}

export function isPartialRead(options: NormalizedReadMultipleOptions): boolean {
  return (
    options.lineRange !== undefined ||
    options.head !== undefined ||
    options.tail !== undefined
  );
}

export async function collectFileBudget(
  filePaths: string[],
  partialRead: boolean,
  maxTotalSize: number,
  maxSize: number,
  signal?: AbortSignal
): Promise<{
  skippedBudget: Set<number>;
  validated: Map<number, ValidatedFileInfo>;
}> {
  const skippedBudget = new Set<number>();
  const validated = new Map<number, ValidatedFileInfo>();

  const { results } = await processInParallel(
    filePaths.map((filePath, index) => ({ filePath, index })),
    async ({ filePath, index }) => {
      const validPath = await validateExistingPath(filePath, signal);
      const stats = await withAbort(fs.stat(validPath), signal);
      return { filePath, index, validPath, stats };
    },
    PARALLEL_CONCURRENCY,
    signal
  );

  let totalSize = 0;
  const orderedResults = [...results].sort((a, b) => a.index - b.index);

  for (const result of orderedResults) {
    validated.set(result.index, {
      index: result.index,
      filePath: result.filePath,
      validPath: result.validPath,
      stats: result.stats,
    });
    const estimatedSize = partialRead
      ? Math.min(result.stats.size, maxSize)
      : result.stats.size;
    if (totalSize + estimatedSize > maxTotalSize) {
      skippedBudget.add(result.index);
      continue;
    }
    totalSize += estimatedSize;
  }

  return { skippedBudget, validated };
}

export function buildProcessTargets(
  filePaths: string[],
  skippedBudget: Set<number>,
  validated: Map<number, ValidatedFileInfo>
): {
  filePath: string;
  index: number;
  validPath?: string;
  stats?: Stats;
}[] {
  return filePaths
    .map((filePath, index) => {
      const cached = validated.get(index);
      return cached
        ? {
            filePath,
            index,
            validPath: cached.validPath,
            stats: cached.stats,
          }
        : { filePath, index };
    })
    .filter(({ index }) => !skippedBudget.has(index));
}

export function applyParallelResults(
  output: ReadMultipleResult[],
  results: { index: number; value: ReadMultipleResult }[],
  errors: { index: number; error: Error }[],
  filePaths: string[]
): void {
  for (const result of results) {
    output[result.index] = result.value;
  }

  for (const failure of errors) {
    const filePath = filePaths[failure.index] ?? '(unknown)';
    output[failure.index] = {
      path: filePath,
      error: failure.error.message,
    };
  }
}

export function applySkippedBudgetErrors(
  output: ReadMultipleResult[],
  skippedBudget: Set<number>,
  filePaths: string[],
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

export function mapParallelErrors(
  errors: { index: number; error: Error }[],
  filesToProcess: { filePath: string; index: number }[]
): { index: number; error: Error }[] {
  return errors.map((failure) => {
    const target = filesToProcess[failure.index];
    return {
      index: target?.index ?? -1,
      error: failure.error,
    };
  });
}

export async function readFilesInParallel(
  filesToProcess: {
    filePath: string;
    index: number;
    validPath?: string;
    stats?: Stats;
  }[],
  options: NormalizedReadMultipleOptions,
  signal?: AbortSignal
): Promise<{
  results: { index: number; value: ReadMultipleResult }[];
  errors: { index: number; error: Error }[];
}> {
  return await processInParallel(
    filesToProcess,
    async ({ filePath, index, validPath, stats }) => {
      const readOptions = {
        encoding: options.encoding,
        maxSize: options.maxSize,
        head: options.head,
        tail: options.tail,
        lineRange: options.lineRange,
        signal,
      };
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
    },
    PARALLEL_CONCURRENCY,
    signal
  );
}
