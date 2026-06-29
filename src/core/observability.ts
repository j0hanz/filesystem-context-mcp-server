import { AsyncLocalStorage } from 'node:async_hooks';

export type LoggingLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

export interface LogSender {
  send(level: LoggingLevel, message: string): Promise<void>;
}

interface SessionContextData {
  sessionId?: string;
}

const SessionContext = new AsyncLocalStorage<SessionContextData>();

export function withSession<T>(sessionId: string | undefined, run: () => Promise<T>): Promise<T> {
  const store: SessionContextData = sessionId ? { sessionId } : {};
  return SessionContext.run(store, run);
}

export interface LoggingState {
  minimumLevel: LoggingLevel;
}

export function createLoggingState(minimumLevel: LoggingLevel = 'debug'): LoggingState {
  return { minimumLevel };
}

export const Logger = {
  emit: (level: LoggingLevel, message: string) => {
    console.error(`[${level}] ${message}`);
  },
  info: (message: string, ...args: unknown[]) => {
    console.error(`[info] ${message}`, ...args);
  },
  warn: (message: string, ...args: unknown[]) => {
    console.error(`[warning] ${message}`, ...args);
  },
  error: (message: string, ...args: unknown[]) => {
    console.error(`[error] ${message}`, ...args);
  },
  debug: (message: string, ...args: unknown[]) => {
    console.error(`[debug] ${message}`, ...args);
  },
  setRouter: (): void => undefined,
  getRouter: () => null as unknown as LogRouter,
};

export async function withTelemetry<T>(
  baseEvent: { event: string; [key: string]: unknown },
  handler: (enrich: (extraData: Record<string, unknown>) => void) => Promise<T> | T,
): Promise<T> {
  const enrich = (): void => undefined;
  try {
    return await handler(enrich);
  } catch (error) {
    console.error(`[withTelemetry] error in ${baseEvent.event}:`, error);
    throw error;
  }
}

export function logRuntimeFailure(id: string, scope: string, method: string, error: unknown): void {
  console.error(`Runtime failure: ${id} [${scope}.${method}]`, error);
}

export function logToSender(
  _sender: LogSender | undefined,
  level: LoggingLevel,
  message: string,
  _minLevel?: LoggingLevel,
): void {
  Logger.emit(level, message);
}

export interface LogRouter {
  addSender(sender: LogSender): void;
  removeSender(sender: LogSender): void;
  attachSession(sessionId: string, sender: LogSender): void;
  detachSession(sessionId: string): void;
}
