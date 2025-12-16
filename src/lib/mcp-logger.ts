import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';

// Store the low-level server instance for logging
let mcpServerInstance: McpServer | null = null;
let loggingFailureCount = 0;
const MAX_FAILURE_WARNINGS = 10;

export function setMcpServerInstance(server: McpServer): void {
  mcpServerInstance = server;
  loggingFailureCount = 0; // Reset counter on new server
}

// Internal logging function - use `logger` object for external access
function mcpLog(level: LogLevel, data: string, loggerName?: string): void {
  if (!mcpServerInstance) {
    console.error(`[${level}] ${loggerName ? `${loggerName}: ` : ''}${data}`);
    return;
  }

  mcpServerInstance.server
    .sendLoggingMessage({
      level,
      data,
      logger: loggerName,
    })
    .catch(() => {
      loggingFailureCount++;
      console.error(`[${level}] ${loggerName ? `${loggerName}: ` : ''}${data}`);

      if (loggingFailureCount === MAX_FAILURE_WARNINGS) {
        console.error(
          '[CRITICAL] MCP logging failed 10 times. Further failures will not be reported.'
        );
      }
    });
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
