import type {
  LoggingLevel,
  LoggingMessageNotificationParams,
  McpServer,
} from '@modelcontextprotocol/server';

import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { inspect } from 'node:util';

interface SessionContextData {
  sessionId?: string;
}

export const SessionContext = new AsyncLocalStorage<SessionContextData>();

interface LogEvent {
  level: LoggingLevel;
  message: string;
  data?: unknown;
  sessionId?: string;
}

const LOG_CHANNEL = channel('filesystem-mcp:log');
const MCP_LOGGER_NAME = 'filesystem-mcp';

const LOG_LEVEL_ORDER: Record<LoggingLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7,
};

export interface LoggingState {
  minimumLevel: LoggingLevel;
}

export function createLoggingState(
  minimumLevel: LoggingLevel = 'debug'
): LoggingState {
  return { minimumLevel };
}

function canSendMcpLogs(server: McpServer): boolean {
  const capabilities = server.server.getClientCapabilities();
  if (!capabilities || typeof capabilities !== 'object') return false;
  return 'logging' in capabilities && Boolean(capabilities.logging);
}

export function logToMcp(
  server: McpServer | undefined,
  level: LoggingLevel,
  data: string,
  minLevel: LoggingLevel = 'debug'
): void {
  if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[minLevel]) {
    return;
  }
  if (!server || !canSendMcpLogs(server)) {
    console.error(`[${level.toUpperCase()}] ${data}`);
    return;
  }

  const params: LoggingMessageNotificationParams = {
    level,
    logger: MCP_LOGGER_NAME,
    data,
  };

  void server.sendLoggingMessage(params).catch((error: unknown) => {
    console.error(
      `Failed to send MCP log: ${level} | ${data}`,
      formatTransportError(error)
    );
  });
}

function formatTransportError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}

export const Logger = {
  emit(level: LoggingLevel, message: string, data?: unknown): void {
    const session = SessionContext.getStore();
    const event: LogEvent = {
      level,
      message,
      ...(data !== undefined ? { data } : {}),
      ...(session?.sessionId !== undefined
        ? { sessionId: session.sessionId }
        : {}),
    };

    if (LOG_CHANNEL.hasSubscribers) {
      LOG_CHANNEL.publish(event);
    } else {
      // Fallback if no subscribers
      console.error(`[${level.toUpperCase()}] ${message}`, data ?? '');
    }
  },

  debug(message: string, data?: unknown): void {
    this.emit('debug', message, data);
  },

  info(message: string, data?: unknown): void {
    this.emit('info', message, data);
  },

  notice(message: string, data?: unknown): void {
    this.emit('notice', message, data);
  },

  warn(message: string, data?: unknown): void {
    this.emit('warning', message, data);
  },

  error(message: string, data?: unknown): void {
    this.emit('error', message, data);
  },

  critical(message: string, data?: unknown): void {
    this.emit('critical', message, data);
  },
};

/**
 * Routes log events from the `filesystem-mcp:log` diagnostics channel to the
 * correct McpServer. Stdio uses a single fallback target; HTTP attaches one
 * target per session keyed by `sessionId`. Subscribes to the channel exactly
 * once on first construction.
 */
export interface LogTarget {
  server: McpServer;
  loggingState: LoggingState;
}

function stringifyLogData(data: unknown): string {
  if (data === undefined) return '';
  if (typeof data === 'string') return ` ${data}`;
  if (
    data === null ||
    typeof data === 'number' ||
    typeof data === 'boolean' ||
    typeof data === 'bigint'
  ) {
    return ` ${String(data)}`;
  }
  return ` ${inspect(data, { depth: 4, colors: false, compact: 3 })}`;
}

export class LogRouter {
  private static instance: LogRouter | undefined;
  private stdio: LogTarget | undefined;
  private readonly sessions = new Map<string, LogTarget>();

  private constructor() {
    LOG_CHANNEL.subscribe((message) => {
      this.dispatch(message as LogEvent);
    });
  }

  static global(): LogRouter {
    LogRouter.instance ??= new LogRouter();
    return LogRouter.instance;
  }

  attachStdio(target: LogTarget): void {
    this.stdio ??= target;
  }

  detachStdio(): void {
    this.stdio = undefined;
  }

  attachSession(sessionId: string, target: LogTarget): void {
    this.sessions.set(sessionId, target);
  }

  detachSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** For tests: forget all routing state without unsubscribing the channel. */
  reset(): void {
    this.stdio = undefined;
    this.sessions.clear();
  }

  private dispatch(event: LogEvent): void {
    const target = event.sessionId
      ? this.sessions.get(event.sessionId)
      : this.stdio;
    const dataStr = stringifyLogData(event.data);
    if (target) {
      logToMcp(
        target.server,
        event.level,
        `${event.message}${dataStr}`,
        target.loggingState.minimumLevel
      );
      return;
    }
    console.error(`[${event.level.toUpperCase()}] ${event.message}${dataStr}`);
  }
}
