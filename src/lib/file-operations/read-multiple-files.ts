import { collectFileBudget } from './read-multiple-budget.js';
import type {
  ReadMultipleOptions,
  ReadMultipleResult,
} from './read-multiple-files-helpers.js';
import {
  applyErrors,
  applyResults,
  applySkippedBudget,
  buildFilesToProcess,
  buildOutput,
  isPartialRead,
  readFilesInParallel,
  resolveNormalizedOptions,
} from './read-multiple-files-helpers.js';

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

export type {
  ReadMultipleOptions,
  ReadMultipleResult,
} from './read-multiple-files-helpers.js';
