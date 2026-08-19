import { AsyncLocalStorage } from 'node:async_hooks';

export type LoggingLevel =
  'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';

interface SessionContextData {
  sessionId?: string;
}

const SessionContext = new AsyncLocalStorage<SessionContextData>();

export function withSession<T>(sessionId: string | undefined, run: () => Promise<T>): Promise<T> {
  const store: SessionContextData = sessionId ? { sessionId } : {};
  return SessionContext.run(store, run);
}

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
  const raw = process.env['LOG_LEVEL']?.trim().toLowerCase();
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
 * Read once at import: `src/index.ts` lifts the flag into the environment
 * before any module that reads it loads.
 */
const LOG_LEVEL: LoggingLevel = parseLogLevelEnv();

/** True when `level` is at least as severe as the configured minimum. */
export function isLevelEnabled(level: LoggingLevel, minimum: LoggingLevel = LOG_LEVEL): boolean {
  return LEVEL_ORDER.indexOf(level) <= LEVEL_ORDER.indexOf(minimum);
}

function write(level: LoggingLevel, message: string, args: readonly unknown[]): void {
  if (!isLevelEnabled(level)) return;
  const sessionId = SessionContext.getStore()?.sessionId;
  const prefix = sessionId ? `[${level}] [session ${sessionId}]` : `[${level}]`;
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
