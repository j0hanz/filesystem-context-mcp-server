import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';

import { ErrorCode, McpError } from '../../errors.js';
import { validateExistingPath } from '../../path-validation.js';
import { assertNotAborted, withAbort } from '../abort.js';
import { assertNotBinary } from './binary-check.js';
import { readByMode } from './read-modes.js';
import {
  type NormalizedOptions,
  normalizeOptions,
  type ReadFileOptions,
  type ReadFileResult,
} from './read-options.js';

function assertFileStats(filePath: string, stats: Stats): void {
  if (!stats.isFile()) {
    throw new McpError(
      ErrorCode.E_NOT_FILE,
      `Not a file: ${filePath}`,
      filePath
    );
  }
}

function assertSingleReadMode(
  filePath: string,
  normalized: NormalizedOptions
): void {
  const optionsCount = [
    normalized.lineRange,
    normalized.head,
    normalized.tail,
  ].filter(Boolean).length;

  if (optionsCount > 1) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Cannot specify multiple of lineRange, head, or tail simultaneously',
      filePath
    );
  }
}

async function readFileWithStatsInternal(
  filePath: string,
  validPath: string,
  stats: Stats,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  assertNotAborted(normalized.signal);

  assertFileStats(filePath, stats);
  assertSingleReadMode(filePath, normalized);

  if (normalized.skipBinary) {
    await assertNotBinary(validPath, filePath, normalized);
  }
  assertNotAborted(normalized.signal);

  // Open FileHandle once, use for all reads, close atomically
  const handle = await withAbort(fs.open(validPath, 'r'), normalized.signal);
  try {
    return await readByMode(handle, validPath, filePath, stats, normalized);
  } finally {
    await handle.close();
  }
}

export async function readFileWithStats(
  filePath: string,
  validPath: string,
  stats: Stats,
  options: ReadFileOptions = {}
): Promise<ReadFileResult> {
  const normalized = normalizeOptions(options);
  assertNotAborted(normalized.signal);
  return await readFileWithStatsInternal(
    filePath,
    validPath,
    stats,
    normalized
  );
}

export async function readFile(
  filePath: string,
  options: ReadFileOptions = {}
): Promise<ReadFileResult> {
  const normalized = normalizeOptions(options);
  assertNotAborted(normalized.signal);
  const validPath = await validateExistingPath(filePath, normalized.signal);
  assertNotAborted(normalized.signal);
  const stats = await withAbort(fs.stat(validPath), normalized.signal);

  return await readFileWithStatsInternal(
    filePath,
    validPath,
    stats,
    normalized
  );
}
