import { availableParallelism } from 'node:os';

import { cli } from './config.js';
import { Logger } from './observability.js';
import { parseTrueEnvFlag } from './primitives.js';

export const KIB = 1024;
export const MIB = 1024 * KIB;
export const GIB = 1024 * MIB;

const loggedWarns = new Set<string>();

function logInvalidEnvValue(
  envVar: string,
  value: string,
  expected: string,
  defaultValue: number | boolean,
): void {
  const key = `${envVar}:${value}:${expected}`;
  if (loggedWarns.has(key)) {
    return;
  }
  loggedWarns.add(key);
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
  return parseIntSetting(envVar, process.env[envVar], defaultValue, min, max);
}

/** Validate a raw integer setting (env var or CLI override) with a logged fallback. */
export function parseIntSetting(
  name: string,
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
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
    logInvalidEnvValue(name, value, `${String(min)}-${String(max)}`, defaultValue);
    return defaultValue;
  }
  return parsed;
}

/**
 * Split a comma-separated config value into trimmed, non-empty entries. Empty
 * entries are dropped so "," or " " reads as unset rather than as a list of
 * blanks. Every comma-separated env var this server accepts parses through
 * here, so they all agree on what "configured" means.
 */
export function splitCsvList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getInitTimeoutClose(): boolean {
  return parseTrueEnvFlag(process.env['FS_INIT_TIMEOUT_CLOSE']);
}

export const PARALLEL_CONCURRENCY = Math.min(Math.max(availableParallelism(), 4), 32);

export const ROOTS_TIMEOUT_MS = 5000;

export function getMaxTextFileSize(): number {
  return parseIntSetting(
    'MAX_FILE_SIZE',
    cli.maxFileSize ?? process.env['MAX_FILE_SIZE'],
    10 * MIB,
    MIB,
    100 * MIB,
  );
}

export function getDefaultReadManyMaxTotalSize(): number {
  return parseEnvInt('MAX_READ_MANY_TOTAL_SIZE', 512 * KIB, 10 * KIB, 100 * MIB);
}

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
