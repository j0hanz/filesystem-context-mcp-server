#!/usr/bin/env node
import type { McpServer } from '@modelcontextprotocol/server';

import type * as http from 'node:http';
import process from 'node:process';

import { z } from 'zod/v4';

import { formatUnknownErrorMessage } from './lib/errors.js';
import { shutdownWorkerPool } from './lib/worker-pool.js';

import { CliExitError, parseArgs } from './cli.js';
import { createServer, startHttpServer, startServer } from './server.js';

// Ensure consistent English error messages across all locales.
z.config(z.locales.en());

const SHUTDOWN_TIMEOUT_MS = 5000;
let activeServer: McpServer | undefined;
let activeHttpServer: http.Server | undefined;
let shutdownStarted = false;

function isStdinEvent(event: NodeJS.Signals | 'end' | 'close'): boolean {
  return event === 'end' || event === 'close';
}

function registerShutdownTrigger(
  event: NodeJS.Signals | 'end' | 'close'
): void {
  const target = isStdinEvent(event) ? process.stdin : process;
  target.once(event, () => {
    const reason = isStdinEvent(event) ? `stdin ${event}` : event;
    void shutdown(reason, 0);
  });
}

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;

  process.exitCode = exitCode;
  let keepForceExitTimer = true;

  const timer = setTimeout(() => {
    console.error(`Shutdown timed out (${reason}), forcing exit.`);
    process.exit(exitCode);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();

  try {
    if (activeHttpServer) {
      const server = activeHttpServer;
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    if (activeServer) {
      await activeServer.close();
    }
    await shutdownWorkerPool();
    keepForceExitTimer = false;
  } catch (error: unknown) {
    console.error(
      `Shutdown error (${reason}):`,
      formatUnknownErrorMessage(error)
    );
  } finally {
    if (!keepForceExitTimer) {
      clearTimeout(timer);
    }
  }
}

async function main(): Promise<void> {
  let allowedDirs: string[];
  let allowCwd: boolean;
  let port: number | undefined;
  try {
    const parsed = await parseArgs();
    ({ allowedDirs, allowCwd, port } = parsed);
  } catch (error: unknown) {
    if (error instanceof CliExitError) {
      if (error.message.length > 0) {
        console.error(error.message);
      }
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }

  if (allowedDirs.length > 0) {
    console.error('Allowed directories (from CLI):');
    for (const dir of allowedDirs) {
      console.error(`- ${dir}`);
    }
  } else {
    console.error(
      `No directories specified via CLI. Will use MCP Roots${allowCwd ? ' or current working directory' : ''}.`
    );
  }

  if (port !== undefined) {
    activeHttpServer = await startHttpServer(port, {
      allowCwd,
      cliAllowedDirs: allowedDirs,
    });
  } else {
    const serverAndHandle = await createServer({
      allowCwd,
      cliAllowedDirs: allowedDirs,
    });
    activeServer = serverAndHandle.server;
    await startServer(serverAndHandle);
  }
}

registerShutdownTrigger('SIGTERM');
registerShutdownTrigger('SIGINT');
registerShutdownTrigger('end');
registerShutdownTrigger('close');

process.once('unhandledRejection', (reason: unknown) => {
  console.error('Unhandled rejection:', formatUnknownErrorMessage(reason));
  void shutdown('unhandledRejection', 1);
});

process.once('uncaughtException', (error: Error) => {
  console.error('Uncaught exception:', error);
  void shutdown('uncaughtException', 1);
});

main().catch((error: unknown) => {
  console.error('Fatal error:', formatUnknownErrorMessage(error));
  void shutdown('fatal', 1);
});
