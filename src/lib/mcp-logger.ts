import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';

// Store the low-level server instance for logging
let mcpServerInstance: McpServer | null = null;

export function setMcpServerInstance(server: McpServer): void {
  mcpServerInstance = server;
}

// Internal logging function - use `logger` object for external access
function mcpLog(level: LogLevel, data: string, loggerName?: string): void {
  if (!mcpServerInstance) {
    // Fallback to stderr if server not connected
    console.error(`[${level}] ${loggerName ? `${loggerName}: ` : ''}${data}`);
    return;
  }

  try {
    mcpServerInstance.server
      .sendLoggingMessage({
        level,
        data,
        logger: loggerName,
      })
      .catch(() => {
        // Logging failed - fallback handled below
      });
  } catch {
    // Ignore logging errors - don't break operations
    console.error(`[${level}] ${data}`);
  }
}

export const logger = {
  debug: (msg: string, loggerName?: string): void => {
    mcpLog('debug', msg, loggerName);
  },
  info: (msg: string, loggerName?: string): void => {
    mcpLog('info', msg, loggerName);
  },
  notice: (msg: string, loggerName?: string): void => {
    mcpLog('notice', msg, loggerName);
  },
  warning: (msg: string, loggerName?: string): void => {
    mcpLog('warning', msg, loggerName);
  },
  error: (msg: string, loggerName?: string): void => {
    mcpLog('error', msg, loggerName);
  },
  critical: (msg: string, loggerName?: string): void => {
    mcpLog('critical', msg, loggerName);
  },
};
