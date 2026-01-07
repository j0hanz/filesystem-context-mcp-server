import { availableParallelism } from 'node:os';

// Helper for parsing environment variables (only used for configurable values)
function parseEnvInt(
  envVar: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const value = process.env[envVar];
  if (!value) return defaultValue;

  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    console.error(
      `[WARNING] Invalid ${envVar} value: ${value} (must be ${String(min)}-${String(max)}). Using default: ${String(defaultValue)}`
    );
    return defaultValue;
  }
  return parsed;
}

// Auto-tuned parallelism based on CPU cores (no env override)
function getOptimalParallelism(): number {
  const cpuCores = availableParallelism();
  return Math.min(Math.max(cpuCores, 4), 32);
}

// Hardcoded optimal values (no env override needed)
export const PARALLEL_CONCURRENCY = getOptimalParallelism();

// Configurable via environment variables
export const MAX_SEARCHABLE_FILE_SIZE = parseEnvInt(
  'MAX_SEARCH_SIZE',
  1024 * 1024,
  100 * 1024,
  10 * 1024 * 1024
);
export const MAX_TEXT_FILE_SIZE = parseEnvInt(
  'MAX_FILE_SIZE',
  10 * 1024 * 1024,
  1024 * 1024,
  100 * 1024 * 1024
);
export const DEFAULT_SEARCH_TIMEOUT_MS = parseEnvInt(
  'DEFAULT_SEARCH_TIMEOUT',
  30000,
  100,
  3600000
);

/**
 * Number of search worker threads to use.
 * Default: CPU cores (capped at 8 for optimal I/O performance).
 * Configurable via FILESYSTEM_CONTEXT_SEARCH_WORKERS env var.
 */
export const SEARCH_WORKERS = parseEnvInt(
  'FILESYSTEM_CONTEXT_SEARCH_WORKERS',
  Math.min(availableParallelism(), 8),
  1,
  16
);

// Hardcoded defaults (use per-call tool params to override)
export const DEFAULT_MAX_DEPTH = 10;
export const DEFAULT_MAX_RESULTS = 100;
export const DEFAULT_LIST_MAX_ENTRIES = 10000;
export const DEFAULT_SEARCH_MAX_FILES = 20000;

// Non-configurable constants
export const MAX_LINE_CONTENT_LENGTH = 200;
export const BINARY_CHECK_BUFFER_SIZE = 512;

export { KNOWN_BINARY_EXTENSIONS } from './constants/binary-extensions.js';
export { DEFAULT_EXCLUDE_PATTERNS } from './constants/exclude-patterns.js';
export { getMimeType } from './constants/mime-types.js';
