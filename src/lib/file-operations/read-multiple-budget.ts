import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';

import { PARALLEL_CONCURRENCY } from '../constants.js';
import { processInParallel } from '../fs-helpers.js';
import { withAbort } from '../fs-helpers/abort.js';
import { validateExistingPath } from '../path-validation.js';

export interface ValidatedFileInfo {
  index: number;
  filePath: string;
  validPath: string;
  stats: Stats;
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
