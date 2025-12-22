import * as fs from 'node:fs/promises';

import { MAX_TEXT_FILE_SIZE, PARALLEL_CONCURRENCY } from '../constants.js';
import { ErrorCode, McpError } from '../errors.js';
import { processInParallel, readFile } from '../fs-helpers.js';
import { validateExistingPath } from '../path-validation.js';

interface ReadMultipleResult {
  path: string;
  content?: string;
  truncated?: boolean;
  totalLines?: number;
  error?: string;
}

interface NormalizedReadMultipleOptions {
  encoding: BufferEncoding;
  maxSize: number;
  maxTotalSize: number;
  head?: number;
  tail?: number;
}

interface ReadMultipleOptions {
  encoding?: BufferEncoding;
  maxSize?: number;
  maxTotalSize?: number;
  head?: number;
  tail?: number;
}

function assertHeadTailOptions(
  head: number | undefined,
  tail: number | undefined
): void {
  if (head === undefined || tail === undefined) return;

  throw new McpError(
    ErrorCode.E_INVALID_INPUT,
    'Cannot specify both head and tail simultaneously',
    undefined
  );
}

function createOutputSkeleton(filePaths: string[]): ReadMultipleResult[] {
  return filePaths.map((filePath) => ({ path: filePath }));
}

function normalizeReadMultipleOptions(
  options: ReadMultipleOptions = {}
): NormalizedReadMultipleOptions {
  return {
    encoding: options.encoding ?? 'utf-8',
    maxSize: options.maxSize ?? MAX_TEXT_FILE_SIZE,
    maxTotalSize: options.maxTotalSize ?? 100 * 1024 * 1024,
    head: options.head,
    tail: options.tail,
  };
}

function isPartialRead(options: NormalizedReadMultipleOptions): boolean {
  return options.head !== undefined || options.tail !== undefined;
}

async function collectFileBudget(
  filePaths: string[],
  isPartialRead: boolean,
  maxTotalSize: number
): Promise<{ skippedBudget: Set<string> }> {
  const skippedBudget = new Set<string>();

  if (isPartialRead) {
    return { skippedBudget };
  }

  // Gather file sizes
  const { results } = await processInParallel(
    filePaths.map((filePath, index) => ({ filePath, index })),
    async ({ filePath, index }) => {
      const validPath = await validateExistingPath(filePath);
      const stats = await fs.stat(validPath);
      return { filePath, index, size: stats.size };
    },
    PARALLEL_CONCURRENCY
  );

  // Determine which files to skip based on budget
  let totalSize = 0;
  const orderedResults = [...results].sort((a, b) => a.index - b.index);

  for (const result of orderedResults) {
    const estimatedSize = result.size;
    if (totalSize + estimatedSize > maxTotalSize) {
      skippedBudget.add(result.filePath);
      continue;
    }
    totalSize += estimatedSize;
  }

  return { skippedBudget };
}

function buildProcessTargets(
  filePaths: string[],
  skippedBudget: Set<string>
): { filePath: string; index: number }[] {
  return filePaths
    .map((filePath, index) => ({ filePath, index }))
    .filter(({ filePath }) => !skippedBudget.has(filePath));
}

function applyParallelResults(
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

function applySkippedBudgetErrors(
  output: ReadMultipleResult[],
  skippedBudget: Set<string>,
  filePaths: string[],
  maxTotalSize: number
): void {
  for (const filePath of skippedBudget) {
    const index = filePaths.indexOf(filePath);
    if (index === -1) continue;

    output[index] = {
      path: filePath,
      error: `Skipped: combined estimated read would exceed maxTotalSize (${maxTotalSize} bytes)`,
    };
  }
}

function mapParallelErrors(
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

async function readFilesInParallel(
  filesToProcess: { filePath: string; index: number }[],
  options: NormalizedReadMultipleOptions
): Promise<{
  results: { index: number; value: ReadMultipleResult }[];
  errors: { index: number; error: Error }[];
}> {
  return await processInParallel(
    filesToProcess,
    async ({ filePath, index }) => {
      const result = await readFile(filePath, {
        encoding: options.encoding,
        maxSize: options.maxSize,
        head: options.head,
        tail: options.tail,
      });

      return {
        index,
        value: {
          path: result.path,
          content: result.content,
          truncated: result.truncated,
          totalLines: result.totalLines,
        },
      };
    },
    PARALLEL_CONCURRENCY
  );
}

export async function readMultipleFiles(
  filePaths: string[],
  options: ReadMultipleOptions = {}
): Promise<ReadMultipleResult[]> {
  if (filePaths.length === 0) return [];

  const normalized = normalizeReadMultipleOptions(options);
  assertHeadTailOptions(normalized.head, normalized.tail);

  const output = createOutputSkeleton(filePaths);
  const partialRead = isPartialRead(normalized);
  const { skippedBudget } = await collectFileBudget(
    filePaths,
    partialRead,
    normalized.maxTotalSize
  );

  const filesToProcess = buildProcessTargets(filePaths, skippedBudget);

  const { results, errors } = await readFilesInParallel(
    filesToProcess,
    normalized
  );
  const mappedErrors = mapParallelErrors(errors, filesToProcess);

  applyParallelResults(output, results, mappedErrors, filePaths);
  applySkippedBudgetErrors(
    output,
    skippedBudget,
    filePaths,
    normalized.maxTotalSize
  );

  return output;
}
