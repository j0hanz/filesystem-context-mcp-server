import { cli } from './config.js';

export type LoggingLevel =
  'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';

// RFC 5424 severities, most severe first. A message is emitted when its
// severity is at least as high as the configured minimum.
const LEVEL_ORDER: readonly LoggingLevel[] = [
  'emergency',
  'alert',
  'critical',
  'error',
  'warning',
  'notice',
  'info',
  'debug',
];

function isLoggingLevel(value: string): value is LoggingLevel {
  return (LEVEL_ORDER as readonly string[]).includes(value);
}

function parseLogLevelEnv(): LoggingLevel {
  const raw = (cli.logLevel ?? process.env['LOG_LEVEL'])?.trim().toLowerCase();
  if (!raw) return 'info';
  // `warn` is the common short form; the canonical RFC 5424 level is `warning`.
  if (raw === 'warn') return 'warning';
  if (isLoggingLevel(raw)) return raw;
  console.error(
    `[warning] Invalid LOG_LEVEL value: ${raw} (must be ${LEVEL_ORDER.join('|')}). Using default: info`,
  );
  return 'info';
}

/**
 * Minimum severity that reaches stderr, from `LOG_LEVEL` / `--log-level`.
 * Evaluated lazily on access.
 */
export function getLogLevel(): LoggingLevel {
  return parseLogLevelEnv();
}

/** True when `level` is at least as severe as the configured minimum. */
export function isLevelEnabled(
  level: LoggingLevel,
  minimum: LoggingLevel = getLogLevel(),
): boolean {
  return LEVEL_ORDER.indexOf(level) <= LEVEL_ORDER.indexOf(minimum);
}

function write(level: LoggingLevel, message: string, args: readonly unknown[]): void {
  if (!isLevelEnabled(level)) return;
  const prefix = `[${level}]`;
  console.error(`${prefix} ${message}`, ...args);
}

export const Logger = {
  emit: (level: LoggingLevel, message: string) => {
    write(level, message, []);
  },
  info: (message: string, ...args: unknown[]) => {
    write('info', message, args);
  },
  warn: (message: string, ...args: unknown[]) => {
    write('warning', message, args);
  },
  error: (message: string, ...args: unknown[]) => {
    write('error', message, args);
  },
  debug: (message: string, ...args: unknown[]) => {
    write('debug', message, args);
  },
};

export function logRuntimeFailure(id: string, scope: string, method: string, error: unknown): void {
  write('error', `Runtime failure: ${id} [${scope}.${method}]`, [error]);
}
