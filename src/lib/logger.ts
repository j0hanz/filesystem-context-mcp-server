import type { LoggingLevel } from '@modelcontextprotocol/sdk/types.js';

import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';

export interface SessionContextData {
  sessionId?: string;
}

export const SessionContext = new AsyncLocalStorage<SessionContextData>();

export interface LogEvent {
  level: LoggingLevel;
  message: string;
  data?: unknown;
  sessionId?: string;
}

const LOG_CHANNEL = channel('filesystem-mcp:log');

export const Logger = {
  emit(level: LoggingLevel, message: string, data?: unknown): void {
    const session = SessionContext.getStore();
    const event: LogEvent = {
      level,
      message,
      data,
      sessionId: session?.sessionId,
    };

    if (LOG_CHANNEL.hasSubscribers) {
      LOG_CHANNEL.publish(event);
    } else {
      // Fallback if no subscribers
      if (
        level === 'error' ||
        level === 'critical' ||
        level === 'alert' ||
        level === 'emergency'
      ) {
        console.error(`[${level.toUpperCase()}] ${message}`, data ?? '');
      } else if (level === 'warning') {
        console.warn(`[${level.toUpperCase()}] ${message}`, data ?? '');
      } else {
        console.log(`[${level.toUpperCase()}] ${message}`, data ?? '');
      }
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
