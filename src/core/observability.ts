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

function serializeLogDetail(arg: unknown): unknown {
  if (arg instanceof Error) {
    return {
      name: arg.name,
      message: arg.message,
      ...(arg.stack ? { stack: arg.stack } : {}),
      ...('code' in arg && typeof arg.code === 'string' ? { code: arg.code } : {}),
    };
  }
  if (typeof arg === 'object' && arg !== null) {
    try {
      JSON.stringify(arg);
      return arg;
    } catch {
      return '[non-serializable object]';
    }
  }
  return arg;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      message: '[observability] Failed to serialize log entry to JSON',
    });
  }
}

function write(level: LoggingLevel, message: string, args: readonly unknown[]): void {
  if (!isLevelEnabled(level)) return;
  if (process.env['LOG_FORMAT'] === 'json') {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(args.length > 0 ? { details: args.map(serializeLogDetail) } : {}),
    };
    console.error(safeJsonStringify(entry));
    return;
  }
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
