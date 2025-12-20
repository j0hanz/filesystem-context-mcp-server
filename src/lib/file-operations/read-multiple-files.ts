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

function assertNoSingleFileParams(options: unknown): void {
  if (!options || typeof options !== 'object') return;
  const opts = options as Record<string, unknown>;
  const unsupported = ['lineStart', 'lineEnd'].filter((key) => key in opts);
  if (unsupported.length > 0) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      `Parameter(s) ${unsupported.join(', ')} are not supported by read_multiple_files. ` +
        `Use read_file for line ranges, or use head/tail with read_multiple_files.`,
      undefined,
      {
        suggestion:
          'Call read_file({ path, lineStart, lineEnd }) for single-file line ranges.',
      }
    );
  }
}

function createOutputSkeleton(filePaths: string[]): ReadMultipleResult[] {
  return filePaths.map((filePath) => ({ path: filePath }));
}

async function collectFileBudget(
  filePaths: string[],
  isPartialRead: boolean,
  maxTotalSize: number
): Promise<{ skippedBudget: Set<string> }> {
  const skippedBudget = new Set<string>();

  // If performing partial read (head/tail), skip size checks
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
    if (totalSize + result.size > maxTotalSize) {
      skippedBudget.add(result.filePath);
      continue;
    }
    totalSize += result.size;
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

export async function readMultipleFiles(
  filePaths: string[],
  options: {
    encoding?: BufferEncoding;
    maxSize?: number;
    maxTotalSize?: number;
    head?: number;
    tail?: number;
  } = {}
): Promise<ReadMultipleResult[]> {
  if (filePaths.length === 0) return [];

  const {
    encoding = 'utf-8',
    maxSize = MAX_TEXT_FILE_SIZE,
    maxTotalSize = 100 * 1024 * 1024,
    head,
    tail,
  } = options;

  assertHeadTailOptions(head, tail);
  assertNoSingleFileParams(options);

  const output = createOutputSkeleton(filePaths);
  const isPartialRead = head !== undefined || tail !== undefined;
  const { skippedBudget } = await collectFileBudget(
    filePaths,
    isPartialRead,
    maxTotalSize
  );

  const filesToProcess = buildProcessTargets(filePaths, skippedBudget);

  const { results, errors } = await processInParallel(
    filesToProcess,
    async ({ filePath, index }) => {
      const result = await readFile(filePath, {
        encoding,
        maxSize,
        head,
        tail,
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

  const mappedErrors = errors.map((failure) => {
    const target = filesToProcess[failure.index];
    return {
      index: target?.index ?? -1,
      error: failure.error,
    };
  });

  applyParallelResults(output, results, mappedErrors, filePaths);
  applySkippedBudgetErrors(output, skippedBudget, filePaths, maxTotalSize);

  return output;
}
