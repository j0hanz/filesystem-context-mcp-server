import type {
  GetMultipleFileInfoResult,
  MultipleFileInfoResult,
} from '../../config/types.js';
import { PARALLEL_CONCURRENCY } from '../constants.js';
import { processInParallel } from '../fs-helpers.js';
import { getFileInfo } from './file-info.js';

interface GetMultipleFileInfoOptions {
  includeMimeType?: boolean;
  signal?: AbortSignal;
}

async function processFileInfo(
  filePath: string,
  options: GetMultipleFileInfoOptions
): Promise<MultipleFileInfoResult> {
  const info = await getFileInfo(filePath, {
    includeMimeType: options.includeMimeType,
    signal: options.signal,
  });

  return {
    path: filePath,
    info,
  };
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
  if (paths.length === 0) {
    return {
      results: [],
      summary: { total: 0, succeeded: 0, failed: 0, totalSize: 0 },
    };
  }

  const output: MultipleFileInfoResult[] = paths.map((filePath) => ({
    path: filePath,
  }));

  const { results, errors } = await processInParallel(
    paths.map((filePath, index) => ({ filePath, index })),
    async ({ filePath, index }) => ({
      index,
      value: await processFileInfo(filePath, options),
    }),
    PARALLEL_CONCURRENCY,
    options.signal
  );

  for (const result of results) {
    output[result.index] = result.value;
  }

  for (const failure of errors) {
    const filePath = paths[failure.index] ?? '(unknown)';
    if (output[failure.index] !== undefined) {
      output[failure.index] = { path: filePath, error: failure.error.message };
    }
  }

  return {
    results: output,
    summary: calculateSummary(output),
  };
}
