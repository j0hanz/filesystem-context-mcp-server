import { availableParallelism } from 'node:os';

type EnvParseResult = number | null | undefined;

function parseEnvIntValue(
  envVar: string,
  min: number,
  max: number
): EnvParseResult {
  const value = process.env[envVar];
  if (!value) return undefined;

  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    return null;
  }

  return parsed;
}

// Helper function for parsing and validating integer environment variables
function parseEnvInt(
  envVar: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const parsed = parseEnvIntValue(envVar, min, max);
  if (parsed === undefined) return defaultValue;
  if (parsed === null) {
    const value = process.env[envVar] ?? '';
    console.error(
      `[WARNING] Invalid ${envVar} value: ${value} (must be ${min}-${max}). Using default: ${defaultValue}`
    );
    return defaultValue;
  }
  return parsed;
}

function parseOptionalEnvInt(
  envVar: string,
  min: number,
  max: number
): number | undefined {
  const parsed = parseEnvIntValue(envVar, min, max);
  if (parsed === undefined) return undefined;
  if (parsed === null) {
    const value = process.env[envVar] ?? '';
    console.error(
      `[WARNING] Invalid ${envVar} value: ${value} (must be ${min}-${max}). Ignoring.`
    );
    return undefined;
  }
  return parsed;
}

// Determine optimal parallelism based on CPU cores
function getOptimalParallelism(): number {
  const cpuCores = availableParallelism();
  return Math.min(Math.max(cpuCores, 4), 32);
}

const UV_THREADPOOL_LIMIT = parseOptionalEnvInt('UV_THREADPOOL_SIZE', 1, 1024);

const BASE_PARALLEL_CONCURRENCY = parseEnvInt(
  'FILESYSTEM_CONTEXT_CONCURRENCY',
  getOptimalParallelism(),
  1,
  100
);

const MAX_SEARCH_WORKERS = Math.max(1, availableParallelism() - 1);
const BASE_SEARCH_WORKERS = parseEnvInt(
  'FILESYSTEM_CONTEXT_SEARCH_WORKERS',
  0,
  0,
  32
);

export const PARALLEL_CONCURRENCY =
  UV_THREADPOOL_LIMIT !== undefined
    ? Math.min(BASE_PARALLEL_CONCURRENCY, UV_THREADPOOL_LIMIT)
    : BASE_PARALLEL_CONCURRENCY;
export const SEARCH_WORKERS =
  BASE_SEARCH_WORKERS > 0
    ? Math.min(BASE_SEARCH_WORKERS, MAX_SEARCH_WORKERS)
    : 0;
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

export const MAX_LINE_CONTENT_LENGTH = 200;
export const BINARY_CHECK_BUFFER_SIZE = 512;

export const DEFAULT_MAX_DEPTH = parseEnvInt('DEFAULT_DEPTH', 10, 1, 100);
export const DEFAULT_MAX_RESULTS = parseEnvInt(
  'DEFAULT_RESULTS',
  100,
  10,
  10000
);
export const DEFAULT_LIST_MAX_ENTRIES = parseEnvInt(
  'DEFAULT_LIST_MAX_ENTRIES',
  10000,
  100,
  100000
);
export const DEFAULT_SEARCH_MAX_FILES = parseEnvInt(
  'DEFAULT_SEARCH_MAX_FILES',
  20000,
  100,
  100000
);
export const DEFAULT_SEARCH_TIMEOUT_MS = parseEnvInt(
  'DEFAULT_SEARCH_TIMEOUT',
  30000,
  100,
  3600000
);
export { KNOWN_BINARY_EXTENSIONS } from './constants/binary-extensions.js';
export { DEFAULT_EXCLUDE_PATTERNS } from './constants/exclude-patterns.js';
export { getMimeType } from './constants/mime-types.js';
