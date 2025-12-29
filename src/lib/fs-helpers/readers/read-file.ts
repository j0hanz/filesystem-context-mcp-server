import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';

import { validateExistingPath } from '../../path-validation.js';
import { assertNotAborted, withAbort } from '../abort.js';
import {
  assertIsFile,
  assertNotBinary,
  assertSingleMode,
  type NormalizedOptions,
  normalizeOptions,
  readByMode,
  type ReadFileOptions,
  type ReadFileResult,
} from './read-file-utils.js';

async function readFileWithStatsInternal(
  filePath: string,
  validPath: string,
  stats: Stats,
  normalized: NormalizedOptions
): Promise<ReadFileResult> {
  assertNotAborted(normalized.signal);
  assertIsFile(stats, filePath);
  assertSingleMode(normalized, filePath);
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
