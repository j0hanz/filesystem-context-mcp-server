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

async function readFileWithStatsInternal(
  filePath: string,
  validPath: string,
  stats: Stats,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  assertNotAborted(normalized.signal);

  if (!stats.isFile()) {
    throw new McpError(
      ErrorCode.E_NOT_FILE,
      `Not a file: ${filePath}`,
      filePath
    );
  }

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

  if (normalized.skipBinary) {
    await assertNotBinary(validPath, filePath, normalized);
  }
  assertNotAborted(normalized.signal);
  return await readByMode(validPath, filePath, stats, normalized);
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
