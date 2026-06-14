import { availableParallelism } from 'node:os';

import * as z from 'zod/v4';

import { Logger } from './observability.js';
import { parseTrueEnvFlag } from './primitives.js';

export function debounce<Args extends unknown[]>(
  func: (...args: Args) => void,
  waitMs: number,
): { (...args: Args): void; cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const debounced = (...args: Args): void => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      timeoutId = undefined;
      func(...args);
    }, waitMs);
    timeoutId.unref();
  };
  debounced.cancel = () => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };
  return debounced;
}

export function omitOptionKeys<T extends object, K extends keyof T>(
  input: T,
  keys: readonly K[],
): Omit<T, K> {
  const keySet = new Set<PropertyKey>(keys as readonly PropertyKey[]);
  const output = Object.fromEntries(Object.entries(input).filter(([key]) => !keySet.has(key)));
  return output as Omit<T, K>;
}

// Copies non-undefined source properties onto target; safe under exactOptionalPropertyTypes.
export function assignDefined<T extends object>(
  target: T,
  source: { [K in keyof T]?: T[K] | undefined },
): T {
  for (const key of Object.keys(source) as (keyof T)[]) {
    const value = source[key];
    if (value !== undefined) {
      (target as Record<PropertyKey, unknown>)[key] = value;
    }
  }
  return target;
}

function shouldStripStructuredOutput(): boolean {
  return parseTrueEnvFlag(process.env['FS_CONTEXT_STRIP_STRUCTURED']);
}

type StructuredContentKey<T extends object> = Extract<keyof T, 'structuredContent'>;

export type MaybeStrippedStructuredContent<T extends object> = Omit<T, StructuredContentKey<T>> &
  Partial<Pick<T, StructuredContentKey<T>>>;

export function maybeStripStructuredContentFromResult<T extends object>(
  result: T,
): MaybeStrippedStructuredContent<T> {
  if (!shouldStripStructuredOutput()) return result;
  if (!Object.hasOwn(result, 'structuredContent')) return result;

  const stripped = Object.fromEntries(
    Object.entries(result as Record<string, unknown>).filter(
      ([key]) => key !== 'structuredContent',
    ),
  );
  return stripped as MaybeStrippedStructuredContent<T>;
}

const STRING_BOOL_SCHEMA = z.stringbool();

const KIB = 1024;
const MIB = 1024 * KIB;

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
  if (!value) return defaultValue;

  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    logInvalidEnvValue(envVar, value, `${String(min)}-${String(max)}`, defaultValue);
    return defaultValue;
  }
  return parsed;
}

function parseEnvBool(envVar: string, defaultValue: boolean): boolean {
  const value = process.env[envVar];
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  const result = STRING_BOOL_SCHEMA.safeParse(normalized);
  if (!result.success) {
    logInvalidEnvValue(envVar, value, 'true/false', defaultValue);
    return defaultValue;
  }
  return result.data;
}

const VALID_LOG_LEVELS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
] as const;

type ValidLogLevel = (typeof VALID_LOG_LEVELS)[number];

function parseEnvLogLevel(envVar: string, defaultValue: ValidLogLevel): ValidLogLevel {
  const value = process.env[envVar];
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if ((VALID_LOG_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as ValidLogLevel;
  }
  Logger.warn(
    `Invalid ${envVar} value: ${value} (must be ${VALID_LOG_LEVELS.join('|')}). Using default: ${defaultValue}`,
  );
  return defaultValue;
}

export const LOG_LEVEL = parseEnvLogLevel('FILESYSTEM_MCP_LOG_LEVEL', 'info');

export function getInitHandshakeTimeoutMs(): number {
  return parseEnvInt('FS_INIT_HANDSHAKE_TIMEOUT_MS', 30_000, 1_000, 300_000);
}

export const INIT_TIMEOUT_CLOSE = parseTrueEnvFlag(process.env['FS_INIT_TIMEOUT_CLOSE']);

const BYTES_PER_PARALLEL_TASK = 64 * MIB;
const BYTES_PER_SEARCH_WORKER = 128 * MIB;

function getAvailableMemory(): number | undefined {
  if (typeof process.availableMemory !== 'function') return undefined;
  const available = process.availableMemory();
  if (!Number.isFinite(available) || available <= 0) return undefined;
  return available;
}

function applyMemoryBound(cpuBound: number, bytesPerUnit: number, minValue: number): number {
  const availableMemory = getAvailableMemory();
  if (availableMemory === undefined) return cpuBound;
  const memoryBound = Math.floor(availableMemory / bytesPerUnit);
  return Math.min(cpuBound, Math.max(memoryBound, minValue));
}

function getOptimalParallelism(): number {
  const cpuBound = Math.min(Math.max(availableParallelism(), 4), 32);
  return applyMemoryBound(cpuBound, BYTES_PER_PARALLEL_TASK, 2);
}

function getDefaultSearchWorkers(): number {
  const cpuBound = Math.min(availableParallelism(), 8);
  return applyMemoryBound(cpuBound, BYTES_PER_SEARCH_WORKER, 1);
}

export const PARALLEL_CONCURRENCY = getOptimalParallelism();

export const MAX_SEARCHABLE_FILE_SIZE = parseEnvInt('MAX_SEARCH_SIZE', MIB, 100 * KIB, 10 * MIB);
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

/**
 * Number of search worker threads to use.
 * Default: CPU cores (capped at 8 for optimal I/O performance).
 * Configurable via FS_CONTEXT_SEARCH_WORKERS env var.
 */
export const SEARCH_WORKERS = parseEnvInt(
  'FS_CONTEXT_SEARCH_WORKERS',
  getDefaultSearchWorkers(),
  1,
  16,
);

const WORKER_POOL_MAX_DEFAULT = Math.min(4, Math.max(1, availableParallelism() - 1));

export const WORKER_POOL_MAX = parseEnvInt('FS_WORKER_POOL_MAX', WORKER_POOL_MAX_DEFAULT, 1, 16);

export const WORKER_IDLE_TIMEOUT_MS = parseEnvInt('FS_WORKER_IDLE_MS', 30_000, 1_000, 10 * 60_000);

export const WORKER_OFFLOAD_THRESHOLD_BYTES = parseEnvInt(
  'FS_WORKER_OFFLOAD_THRESHOLD',
  256 * KIB,
  KIB,
  100 * MIB,
);

export const WORKER_CANCEL_GRACE_MS = parseEnvInt('FS_WORKER_CANCEL_GRACE_MS', 500, 0, 60_000);

export const WORKERS_DISABLED = parseEnvBool('FS_DISABLE_WORKERS', false);

/**
 * Maximum number of tasks queued in the worker pool before new submissions
 * are rejected with a backpressure error. Prevent unbounded queue growth under
 * sustained high-load submission bursts. Configurable via FS_WORKER_QUEUE_MAX.
 * Default is 100 tasks (permits up to WORKER_POOL_MAX in-flight plus headroom
 * for bursts).
 */
export const WORKER_QUEUE_MAX = parseEnvInt('FS_WORKER_QUEUE_MAX', 100, 1, 10_000);

// Hardcoded defaults
export const DEFAULT_SEARCH_MAX_FILES = 20000;

// Schema limits and defaults
export const MAX_TREE_DEPTH = 50;
export const DEFAULT_TREE_ENTRIES = 1000;

export const MAX_LIST_ENTRIES = 20000;

export const MAX_SEARCH_RESULTS = 10000;
export const DEFAULT_SEARCH_RESULTS = 100;
export const MAX_SEARCH_DEPTH = 100;

export const DEFAULT_SEARCH_CONTENT_RESULTS = 500;
