#!/usr/bin/env node
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { setAllowedDirectoriesResolved } from './lib/path-validation/allowed-directories.js';
import { createServer, parseArgs, startServer } from './server.js';

const SHUTDOWN_TIMEOUT_MS = 5000;
let activeServer: McpServer | undefined;
let shutdownStarted = false;

async function shutdown(signal: string): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;

  const timer = setTimeout(() => {
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    if (activeServer) {
      await activeServer.close();
    }
  } catch (error: unknown) {
    console.error(
      `Shutdown error (${signal}):`,
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    clearTimeout(timer);
    process.exit(0);
  }
}

async function main(): Promise<void> {
  const { allowedDirs, allowCwd } = await parseArgs();

  if (allowedDirs.length > 0) {
    await setAllowedDirectoriesResolved(allowedDirs);
    console.error('Allowed directories (from CLI):');
  } else {
    console.error(
      `No directories specified via CLI. Will use MCP Roots${allowCwd ? ' or current working directory' : ''}.`
    );
  }

  const server = createServer({ allowCwd, cliAllowedDirs: allowedDirs });
  activeServer = server;
  await startServer(server);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.stdin.on('end', () => {
  void shutdown('stdin end');
});

process.stdin.on('close', () => {
  void shutdown('stdin close');
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error(
    'Unhandled rejection:',
    reason instanceof Error ? reason.message : String(reason)
  );
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught exception:', error.message);
  void shutdown('uncaughtException');
});

main().catch((error: unknown) => {
  console.error(
    'Fatal error:',
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
