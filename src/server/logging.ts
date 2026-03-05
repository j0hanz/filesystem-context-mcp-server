import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  LoggingLevel,
  LoggingMessageNotificationParams,
} from '@modelcontextprotocol/sdk/types.js';

import { formatUnknownErrorMessage } from '../lib/errors.js';
import { isRecord } from '../lib/utils.js';

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
  if (!isRecord(capabilities)) return false;
  if (!('logging' in capabilities)) return false;
  return !!capabilities['logging'];
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
    console.error(data);
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
      formatUnknownErrorMessage(error)
    );
  });
}
