import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';

import { PARALLEL_CONCURRENCY } from '../constants.js';
import { withAbort } from '../fs-helpers/abort.js';
import { processInParallel } from '../fs-helpers/concurrency.js';
import { validateExistingPath } from '../path-validation/validate-existing.js';

export interface ValidatedFileInfo {
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
  const stats = await withAbort(fs.stat(validPath), signal);
  return { filePath, index, validPath, stats };
}

type SizeEstimator = (stats: Stats) => number;

function estimatePartialSize(stats: Stats, maxSize: number): number {
  return Math.min(stats.size, maxSize);
}

function estimateFullSize(stats: Stats): number {
  return stats.size;
}

function applyBudget(
  orderedResults: ValidatedFileInfo[],
  estimateSize: SizeEstimator,
  maxTotalSize: number
): { skippedBudget: Set<number>; validated: Map<number, ValidatedFileInfo> } {
  const skippedBudget = new Set<number>();
  const validated = new Map<number, ValidatedFileInfo>();
  let totalSize = 0;

  for (const result of orderedResults) {
    validated.set(result.index, result);
    const estimatedSize = estimateSize(result.stats);
    if (totalSize + estimatedSize > maxTotalSize) {
      skippedBudget.add(result.index);
      continue;
    }
    totalSize += estimatedSize;
  }

  return { skippedBudget, validated };
}

export async function collectFileBudget(
  filePaths: readonly string[],
  partialRead: boolean,
  maxTotalSize: number,
  maxSize: number,
  signal?: AbortSignal
): Promise<{
  skippedBudget: Set<number>;
  validated: Map<number, ValidatedFileInfo>;
}> {
  const { results } = await processInParallel(
    filePaths.map((filePath, index) => ({ filePath, index })),
    async ({ filePath, index }) => validateFile(filePath, index, signal),
    PARALLEL_CONCURRENCY,
    signal
  );

  const orderedResults = [...results].sort((a, b) => a.index - b.index);
  const estimateSize = partialRead
    ? (stats: Stats) => estimatePartialSize(stats, maxSize)
    : estimateFullSize;
  return applyBudget(orderedResults, estimateSize, maxTotalSize);
}
