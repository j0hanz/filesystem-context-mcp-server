import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';

import type {
  ChecksumAlgorithm,
  ChecksumEncoding,
  ChecksumResult,
  ComputeChecksumsResult,
} from '../../config/types.js';
import { PARALLEL_CONCURRENCY } from '../constants.js';
import { ErrorCode, McpError } from '../errors.js';
import { processInParallel } from '../fs-helpers.js';
import { validateExistingPath } from '../path-validation.js';
import { applyParallelResults, createOutputSkeleton } from './batch-results.js';

interface ComputeChecksumsOptions {
  algorithm?: ChecksumAlgorithm;
  encoding?: ChecksumEncoding;
  maxFileSize?: number;
}

const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const DEFAULT_ALGORITHM: ChecksumAlgorithm = 'sha256';
const DEFAULT_ENCODING: ChecksumEncoding = 'hex';

function normalizeComputeOptions(options: ComputeChecksumsOptions): {
  algorithm: ChecksumAlgorithm;
  encoding: ChecksumEncoding;
  maxFileSize: number;
} {
  return {
    algorithm: options.algorithm ?? DEFAULT_ALGORITHM,
    encoding: options.encoding ?? DEFAULT_ENCODING,
    maxFileSize: options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
  };
}

function buildEmptyResult(): ComputeChecksumsResult {
  return {
    results: [],
    summary: { total: 0, succeeded: 0, failed: 0 },
  };
}

async function computeSingleChecksum(
  filePath: string,
  algorithm: ChecksumAlgorithm,
  encoding: ChecksumEncoding,
  maxFileSize: number
): Promise<ChecksumResult> {
  const validPath = await validateExistingPath(filePath);

  // Check file stats
  const stats = await fs.stat(validPath);

  if (stats.isDirectory()) {
    throw new McpError(
      ErrorCode.E_NOT_FILE,
      `Cannot compute checksum for directory: ${filePath}`,
      filePath
    );
  }

  if (!stats.isFile()) {
    throw new McpError(
      ErrorCode.E_NOT_FILE,
      `Cannot compute checksum for non-file path: ${filePath}`,
      filePath
    );
  }

  if (stats.size > maxFileSize) {
    throw new McpError(
      ErrorCode.E_TOO_LARGE,
      `File exceeds maximum size (${stats.size} > ${maxFileSize}): ${filePath}`,
      filePath
    );
  }

  // Compute hash using streaming for memory efficiency
  const hash = await computeHashStream(
    validPath,
    algorithm,
    maxFileSize,
    filePath
  );
  const checksum = hash.digest(encoding as crypto.BinaryToTextEncoding);

  return {
    path: filePath,
    checksum,
    algorithm,
    size: stats.size,
  };
}

function computeHashStream(
  filePath: string,
  algorithm: ChecksumAlgorithm,
  maxFileSize: number,
  requestedPath: string
): Promise<crypto.Hash> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = createReadStream(filePath);
    let bytesRead = 0;
    let settled = false;

    stream.on('data', (chunk: Buffer | string) => {
      const chunkSize =
        typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      bytesRead += chunkSize;
      if (bytesRead > maxFileSize) {
        const error = new McpError(
          ErrorCode.E_TOO_LARGE,
          `File exceeds maximum size (${bytesRead} > ${maxFileSize}): ${requestedPath}`,
          requestedPath
        );
        if (!settled) {
          settled = true;
          stream.destroy(error);
          reject(error);
        }
        return;
      }
      hash.update(chunk);
    });

    stream.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(hash);
      }
    });

    stream.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function calculateSummary(results: ChecksumResult[]): {
  total: number;
  succeeded: number;
  failed: number;
} {
  let succeeded = 0;
  let failed = 0;

  for (const result of results) {
    if (result.checksum !== undefined) {
      succeeded++;
    } else {
      failed++;
    }
  }

  return {
    total: results.length,
    succeeded,
    failed,
  };
}

export async function computeChecksums(
  paths: string[],
  options: ComputeChecksumsOptions = {}
): Promise<ComputeChecksumsResult> {
  if (paths.length === 0) return buildEmptyResult();

  const { algorithm, encoding, maxFileSize } = normalizeComputeOptions(options);

  const output = createOutputSkeleton(paths, (filePath) => ({
    path: filePath,
    algorithm,
  }));

  const { results, errors } = await processInParallel(
    paths.map((filePath, index) => ({ filePath, index })),
    async ({ filePath, index }) => ({
      index,
      value: await computeSingleChecksum(
        filePath,
        algorithm,
        encoding,
        maxFileSize
      ),
    }),
    PARALLEL_CONCURRENCY
  );

  applyParallelResults(output, results, errors, paths, (filePath, error) => ({
    path: filePath,
    algorithm,
    error: error.message,
  }));

  return {
    results: output,
    summary: calculateSummary(output),
  };
}
