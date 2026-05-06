import { availableParallelism } from 'node:os';

import { Logger } from './logger.js';

const TRUE_ENV_VALUES = new Set(['1', 'true', 'yes', 'y', 'on']);
const FALSE_ENV_VALUES = new Set(['0', 'false', 'no', 'n', 'off']);

export function parseTrueEnvFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  return TRUE_ENV_VALUES.has(value.trim().toLowerCase());
}

const KIB = 1024;
const MIB = 1024 * KIB;

function logInvalidEnvValue(
  envVar: string,
  value: string,
  expected: string,
  defaultValue: number | boolean
): void {
  Logger.warn(
    `Invalid ${envVar} value: ${value} (must be ${expected}). Using default: ${String(defaultValue)}`
  );
}

// Helper for parsing environment variables (only used for configurable values)
export function parseEnvInt(
  envVar: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const value = process.env[envVar];
  if (!value) return defaultValue;

  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    logInvalidEnvValue(
      envVar,
      value,
      `${String(min)}-${String(max)}`,
      defaultValue
    );
    return defaultValue;
  }
  return parsed;
}

function parseEnvBool(envVar: string, defaultValue: boolean): boolean {
  const value = process.env[envVar];
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (TRUE_ENV_VALUES.has(normalized)) return true;
  if (FALSE_ENV_VALUES.has(normalized)) return false;
  logInvalidEnvValue(envVar, value, 'true/false', defaultValue);
  return defaultValue;
}

function parseEnvList(envVar: string): string[] {
  const value = process.env[envVar];
  if (!value) return [];
  const entries: string[] = [];
  for (const token of value.split(/[,\n]/u)) {
    const trimmed = token.trim();
    if (trimmed.length > 0) {
      entries.push(trimmed);
    }
  }
  return entries;
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

function parseEnvLogLevel(
  envVar: string,
  defaultValue: ValidLogLevel
): ValidLogLevel {
  const value = process.env[envVar];
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if ((VALID_LOG_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as ValidLogLevel;
  }
  Logger.warn(
    `Invalid ${envVar} value: ${value} (must be ${VALID_LOG_LEVELS.join('|')}). Using default: ${defaultValue}`
  );
  return defaultValue;
}

export const DEFAULT_LOG_LEVEL = parseEnvLogLevel(
  'FILESYSTEM_MCP_LOG_LEVEL',
  'info'
);

// Default TTL for MCP tasks when the client does not specify one (5 minutes).
export const DEFAULT_TASK_TTL_MS = 5 * 60 * 1000;
export const MAX_TASK_TTL_MS = parseEnvInt(
  'FILESYSTEM_MCP_MAX_TASK_TTL_MS',
  60 * 60 * 1000,
  1_000,
  24 * 60 * 60 * 1000
);
export const MAX_CONCURRENT_TASKS = parseEnvInt(
  'FILESYSTEM_MCP_MAX_CONCURRENT_TASKS',
  100,
  1,
  10_000
);

export const TASK_CANCEL_POLL_MS = 2_000;

export function getInitHandshakeTimeoutMs(): number {
  return parseEnvInt('FS_INIT_HANDSHAKE_TIMEOUT_MS', 30_000, 1_000, 300_000);
}

export const INIT_TIMEOUT_CLOSE = parseTrueEnvFlag(
  process.env.FS_INIT_TIMEOUT_CLOSE
);

export const TASK_POLL_INTERVAL_MS = 500;

/** How long cancelled-task results are retained before lazy eviction. */
export const CANCELLED_RESULT_TTL_MS = 2 * 60 * 1_000; // 2 minutes

// Auto-tuned parallelism based on CPU cores (no env override)
const BYTES_PER_PARALLEL_TASK = 64 * MIB;
const BYTES_PER_SEARCH_WORKER = 128 * MIB;

function getAvailableMemory(): number | undefined {
  if (typeof process.availableMemory !== 'function') return undefined;
  const available = process.availableMemory();
  if (!Number.isFinite(available) || available <= 0) return undefined;
  return available;
}

function applyMemoryBound(
  cpuBound: number,
  bytesPerUnit: number,
  minValue: number
): number {
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

// Hardcoded optimal values (no env override needed)
export const PARALLEL_CONCURRENCY = getOptimalParallelism();

// Configurable via environment variables
export const MAX_SEARCHABLE_FILE_SIZE = parseEnvInt(
  'MAX_SEARCH_SIZE',
  MIB,
  100 * KIB,
  10 * MIB
);
export const MAX_TEXT_FILE_SIZE = parseEnvInt(
  'MAX_FILE_SIZE',
  10 * MIB,
  MIB,
  100 * MIB
);

export const DEFAULT_READ_MANY_MAX_TOTAL_SIZE = parseEnvInt(
  'MAX_READ_MANY_TOTAL_SIZE',
  512 * KIB,
  10 * KIB,
  100 * MIB
);
export const DEFAULT_SEARCH_TIMEOUT_MS = parseEnvInt(
  'DEFAULT_SEARCH_TIMEOUT',
  5000,
  100,
  60000
);

const ALLOW_SENSITIVE_FILES = parseEnvBool('FS_CONTEXT_ALLOW_SENSITIVE', false);
const ENV_DENYLIST = parseEnvList('FS_CONTEXT_DENYLIST');
const ENV_ALLOWLIST = parseEnvList('FS_CONTEXT_ALLOWLIST');

/**
 * Number of search worker threads to use.
 * Default: CPU cores (capped at 8 for optimal I/O performance).
 * Configurable via FS_CONTEXT_SEARCH_WORKERS env var.
 */
export const SEARCH_WORKERS = parseEnvInt(
  'FS_CONTEXT_SEARCH_WORKERS',
  getDefaultSearchWorkers(),
  1,
  16
);

// Hardcoded defaults
export const DEFAULT_MAX_DEPTH = 10;
export const DEFAULT_LIST_MAX_ENTRIES = 20000;
export const DEFAULT_SEARCH_MAX_FILES = 20000;

// Schema limits and defaults
export const MAX_TREE_DEPTH = 50;
export const DEFAULT_TREE_DEPTH = 5;
export const MAX_TREE_ENTRIES = 20000;
export const DEFAULT_TREE_ENTRIES = 1000;

export const MAX_LIST_ENTRIES = 20000;

export const MAX_SEARCH_RESULTS = 10000;
export const DEFAULT_SEARCH_RESULTS = 100;
export const MAX_SEARCH_DEPTH = 100;

export const DEFAULT_SEARCH_CONTENT_RESULTS = 500;

// Non-configurable constants
export const MAX_LINE_CONTENT_LENGTH = 200;
export const BINARY_CHECK_BUFFER_SIZE = 512;

const DEFAULT_SENSITIVE_PATTERNS = [
  '.env',
  '.env.*',
  '.npmrc',
  '.pypirc',
  '.aws/credentials',
  '.aws/config',
  '.mcpregistry_*_token',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.crt',
  '*.cer',
  '*id_rsa*',
  '*id_dsa*',
] as const;

export const SENSITIVE_FILE_DENYLIST = [
  ...(ALLOW_SENSITIVE_FILES ? [] : DEFAULT_SENSITIVE_PATTERNS),
  ...ENV_DENYLIST,
];

export const SENSITIVE_FILE_ALLOWLIST = [...ENV_ALLOWLIST];

export const KNOWN_BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.mp3',
  '.wav',
  '.flac',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.sqlite',
  '.db',
  '.wasm',
  '.bin',
  '.dat',
]);

export const DEFAULT_EXCLUDE_PATTERNS = [
  '**/node_modules',
  '**/node_modules/**',
  '**/dist',
  '**/dist/**',
  '**/build',
  '**/build/**',
  '**/coverage',
  '**/coverage/**',
  '**/.git',
  '**/.git/**',
  '**/.vscode',
  '**/.vscode/**',
  '**/.idea',
  '**/.idea/**',
  '**/.DS_Store',
  '**/.next',
  '**/.next/**',
  '**/.nuxt',
  '**/.nuxt/**',
  '**/.output',
  '**/.output/**',
  '**/.svelte-kit',
  '**/.svelte-kit/**',
  '**/.cache',
  '**/.cache/**',
  '**/.yarn',
  '**/.yarn/**',
  '**/jspm_packages',
  '**/jspm_packages/**',
  '**/bower_components',
  '**/bower_components/**',
  '**/out',
  '**/out/**',
  '**/tmp',
  '**/tmp/**',
  '**/.temp',
  '**/.temp/**',
  '**/npm-debug.log',
  '**/yarn-debug.log',
  '**/yarn-error.log',
  '**/Thumbs.db',
];

const MIME_TYPES = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.bmp', 'image/bmp'],
  ['.tiff', 'image/tiff'],
  ['.tif', 'image/tiff'],
  ['.avif', 'image/avif'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  ['.aac', 'audio/aac'],
  ['.m4a', 'audio/mp4'],
  ['.wma', 'audio/x-ms-wma'],
  ['.opus', 'audio/opus'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.avi', 'video/x-msvideo'],
  ['.mov', 'video/quicktime'],
  ['.wmv', 'video/x-ms-wmv'],
  ['.mkv', 'video/x-matroska'],
  ['.flv', 'video/x-flv'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.log', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.json', 'application/json'],
  ['.jsonc', 'application/json'],
  ['.xml', 'application/xml'],
  ['.yaml', 'text/yaml'],
  ['.yml', 'text/yaml'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.css', 'text/css'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.cjs', 'text/javascript'],
  ['.ts', 'text/typescript'],
  ['.tsx', 'text/typescript'],
  ['.zip', 'application/zip'],
  ['.tar', 'application/x-tar'],
  ['.gz', 'application/gzip'],
  ['.7z', 'application/x-7z-compressed'],
  ['.rar', 'application/vnd.rar'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.wasm', 'application/wasm'],
]);

export function getMimeType(ext: string): string {
  const lowerExt = ext.toLowerCase();
  return MIME_TYPES.get(lowerExt) ?? 'application/octet-stream';
}
