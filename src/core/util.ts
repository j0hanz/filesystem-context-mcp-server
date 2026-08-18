import { availableParallelism } from 'node:os';

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
      try {
        func(...args);
      } catch (error) {
        Logger.error('Unhandled exception in debounced function:', error);
      }
    }, waitMs);
    if (typeof timeoutId.unref === 'function') {
      timeoutId.unref();
    }
  };
  debounced.cancel = () => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };
  return debounced;
}

// Copies non-undefined source properties onto target; safe under exactOptionalPropertyTypes.
export function assignDefined<T extends object>(
  target: T,
  source: { [K in keyof T]?: T[K] | undefined },
): T {
  for (const key of Reflect.ownKeys(source) as (keyof T)[]) {
    const value = (source as Record<PropertyKey, unknown>)[key];
    if (value !== undefined) {
      try {
        (target as Record<PropertyKey, unknown>)[key] = value;
      } catch (err) {
        Logger.warn(`Failed to assign defined property: ${String(key)}`, err);
      }
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

  const { structuredContent, ...rest } = result as Record<string, unknown>;
  return rest as MaybeStrippedStructuredContent<T>;
}

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

export function getInitHandshakeTimeoutMs(): number {
  return parseEnvInt('FS_INIT_HANDSHAKE_TIMEOUT_MS', 30_000, 1_000, 300_000);
}

export const INIT_TIMEOUT_CLOSE = parseTrueEnvFlag(process.env['FS_INIT_TIMEOUT_CLOSE']);

const BYTES_PER_PARALLEL_TASK = 64 * MIB;

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

export const PARALLEL_CONCURRENCY = getOptimalParallelism();

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
