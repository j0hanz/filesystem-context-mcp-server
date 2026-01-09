import type {
  GetMultipleFileInfoResult,
  MultipleFileInfoResult,
} from '../../config/types.js';
import { PARALLEL_CONCURRENCY } from '../constants.js';
import { processInParallel } from '../fs-helpers/concurrency.js';
import { getFileInfo } from './file-info.js';

interface GetMultipleFileInfoOptions {
  includeMimeType?: boolean;
  signal?: AbortSignal;
}

function buildEmptyResult(): GetMultipleFileInfoResult {
  return {
    results: [],
    summary: { total: 0, succeeded: 0, failed: 0, totalSize: 0 },
  };
}

function buildOutput(paths: readonly string[]): MultipleFileInfoResult[] {
  return paths.map((filePath) => ({
    path: filePath,
  }));
}

async function processFileInfo(
  filePath: string,
  options: GetMultipleFileInfoOptions
): Promise<MultipleFileInfoResult> {
  const fileInfoOptions: { includeMimeType?: boolean; signal?: AbortSignal } =
    {};
  if (options.includeMimeType !== undefined) {
    fileInfoOptions.includeMimeType = options.includeMimeType;
  }
  if (options.signal) {
    fileInfoOptions.signal = options.signal;
  }
  const info = await getFileInfo(filePath, fileInfoOptions);

  return {
    path: filePath,
    info,
  };
}

async function readFileInfoInParallel(
  paths: readonly string[],
  options: GetMultipleFileInfoOptions
): Promise<{
  results: { index: number; value: MultipleFileInfoResult }[];
  errors: { index: number; error: Error }[];
}> {
  return await processInParallel(
    paths.map((filePath, index) => ({ filePath, index })),
    async ({ filePath, index }) => ({
      index,
      value: await processFileInfo(filePath, options),
    }),
    PARALLEL_CONCURRENCY,
    options.signal
  );
}

function applyResults(
  output: MultipleFileInfoResult[],
  results: { index: number; value: MultipleFileInfoResult }[]
): void {
  for (const result of results) {
    output[result.index] = result.value;
  }
}

function applyErrors(
  output: MultipleFileInfoResult[],
  errors: { index: number; error: Error }[],
  paths: readonly string[]
): void {
  for (const failure of errors) {
    const filePath = paths[failure.index] ?? '(unknown)';
    if (output[failure.index] !== undefined) {
      output[failure.index] = { path: filePath, error: failure.error.message };
    }
  }
}

function calculateSummary(results: readonly MultipleFileInfoResult[]): {
  total: number;
  succeeded: number;
  failed: number;
  totalSize: number;
} {
  let succeeded = 0;
  let failed = 0;
  let totalSize = 0;

  for (const result of results) {
    if (result.info !== undefined) {
      succeeded++;
      totalSize += result.info.size;
    } else {
      failed++;
    }
  }

  return {
    total: results.length,
    succeeded,
    failed,
    totalSize,
  };
}

export async function getMultipleFileInfo(
  paths: readonly string[],
  options: GetMultipleFileInfoOptions = {}
): Promise<GetMultipleFileInfoResult> {
  if (paths.length === 0) return buildEmptyResult();

  const output = buildOutput(paths);
  const { results, errors } = await readFileInfoInParallel(paths, options);
  applyResults(output, results);
  applyErrors(output, errors, paths);

  return {
    results: output,
    summary: calculateSummary(output),
  };
}
