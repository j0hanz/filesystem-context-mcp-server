import { availableParallelism } from 'node:os';

import { Logger } from './observability.js';
import { parseTrueEnvFlag } from './primitives.js';

export const KIB = 1024;
export const MIB = 1024 * KIB;
export const GIB = 1024 * MIB;

function logInvalidEnvValue(
  envVar: string,
  value: string,
  expected: string,
  defaultValue: number | boolean,
): void {
  Logger.warn(
    `Invalid ${envVar} value: ${value} (must be ${expected}). Using default: ${String(defaultValue)}`,
  );
}

export function parseEnvInt(
  envVar: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const value = process.env[envVar];
  if (!value) {
    return defaultValue;
  }

  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (
    trimmed === '' ||
    Number.isNaN(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < min ||
    parsed > max
  ) {
    logInvalidEnvValue(envVar, value, `${String(min)}-${String(max)}`, defaultValue);
    return defaultValue;
  }
  return parsed;
}

export const INIT_TIMEOUT_CLOSE = parseTrueEnvFlag(process.env['FS_INIT_TIMEOUT_CLOSE']);

const BYTES_PER_PARALLEL_TASK = 64 * MIB;

function getAvailableMemory(): number | undefined {
  if (typeof process.availableMemory !== 'function') {
    return undefined;
  }
  const available = process.availableMemory();
  if (!Number.isFinite(available) || available <= 0) {
    return undefined;
  }
  return available;
}

function getOptimalParallelism(): number {
  const cpuBound = Math.min(Math.max(availableParallelism(), 4), 32);
  const availableMemory = getAvailableMemory();
  if (availableMemory === undefined) {
    return cpuBound;
  }
  const memoryBound = Math.floor(availableMemory / BYTES_PER_PARALLEL_TASK);
  return Math.min(cpuBound, Math.max(memoryBound, 2));
}

export const PARALLEL_CONCURRENCY = getOptimalParallelism();

export const ROOTS_TIMEOUT_MS = 5000;

export const MAX_TEXT_FILE_SIZE = parseEnvInt('MAX_FILE_SIZE', 10 * MIB, MIB, 100 * MIB);

export const DEFAULT_READ_MANY_MAX_TOTAL_SIZE = parseEnvInt(
  'MAX_READ_MANY_TOTAL_SIZE',
  512 * KIB,
  10 * KIB,
  100 * MIB,
);

/** Default line chunk size for read continuation when no explicit range was given. */
export const DEFAULT_CONTINUATION_CHUNK_SIZE = 200;

export const DEFAULT_SEARCH_TIMEOUT_MS = parseEnvInt('DEFAULT_SEARCH_TIMEOUT', 5000, 100, 60000);

export const MAX_TREE_DEPTH = 50;
export const DEFAULT_TREE_ENTRIES = 1000;

export const MAX_LIST_ENTRIES = 20000;

export const MAX_SEARCH_RESULTS = 10000;
export const DEFAULT_SEARCH_RESULTS = 100;
export const MAX_SEARCH_DEPTH = 100;

export const DEFAULT_SEARCH_CONTENT_RESULTS = 500;
