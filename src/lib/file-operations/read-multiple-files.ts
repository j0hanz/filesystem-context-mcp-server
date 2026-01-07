import type { Stats } from 'node:fs';

import { collectFileBudget } from './read-multiple-budget.js';
import type {
  FileReadTask,
  ReadMultipleOptions,
  ReadMultipleResult,
} from './read-multiple-files-helpers.js';
import {
  isPartialRead,
  readFilesInParallel,
  resolveNormalizedOptions,
} from './read-multiple-files-helpers.js';

function buildOutput(filePaths: readonly string[]): ReadMultipleResult[] {
  return filePaths.map((filePath) => ({ path: filePath }));
}

function applyResults(
  output: ReadMultipleResult[],
  results: { index: number; value: ReadMultipleResult }[]
): void {
  for (const result of results) {
    output[result.index] = result.value;
  }
}

function applyErrors(
  output: ReadMultipleResult[],
  errors: { index: number; error: Error }[],
  filesToProcess: { index: number }[],
  filePaths: readonly string[]
): void {
  for (const failure of errors) {
    const target = filesToProcess[failure.index];
    const originalIndex = target?.index ?? -1;
    if (originalIndex < 0) continue;
    const filePath = filePaths[originalIndex] ?? '(unknown)';
    output[originalIndex] = {
      path: filePath,
      error: failure.error.message,
    };
  }
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

  const { normalized, signal } = resolveNormalizedOptions(filePaths, options);

  const output = buildOutput(filePaths);
  const partialRead = isPartialRead(normalized);
  const { skippedBudget, validated } = await collectFileBudget(
    filePaths,
    partialRead,
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
    signal
  );

  applyResults(output, results);
  applyErrors(output, errors, filesToProcess, filePaths);
  applySkippedBudget(output, skippedBudget, filePaths, normalized.maxTotalSize);

  return output;
}
