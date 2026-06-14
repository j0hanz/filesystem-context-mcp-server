#!/usr/bin/env node
// Type-only imports are erased at runtime — safe to keep static.
import type { McpServer } from '@modelcontextprotocol/server';

import type * as http from 'node:http';
import process from 'node:process';

import * as z from 'zod/v4';

// bridge.ts has zero intra-package dependencies; statically importing it here
// does NOT pull in util.ts or any config-bearing module.
import { applyBridgeFlags } from './core/bridge.js';

z.config(z.locales.en());

// Apply bridge flags BEFORE any config-bearing module is imported.
// util.ts freezes env-derived constants (MAX_TEXT_FILE_SIZE, LOG_LEVEL, …)
// on first import. Setting process.env here ensures those constants observe
// the flag values when the dynamic imports below evaluate them.
applyBridgeFlags(process.argv.slice(2));

// Dynamically import all modules that transitively load util.ts so that the
// bridge flags above are in effect when their module-level constants are set.
const { CliExitError, parseArgs, runPrintConfig, allowPath, disallowPath, listAllowedPaths } =
  await import('./cli.js');
const { shutdownWorkerPool } = await import('./core/concurrency.js');
const { shutdownSearchWorkerPool } = await import('./core/search/engine.js');
const { logRuntimeFailure } = await import('./core/observability.js');
const { createServer } = await import('./server.js');
const { startHttpServer, startServer } = await import('./transport.js');

const SHUTDOWN_TIMEOUT_MS = 5000;
let activeServer: McpServer | undefined;
let activeHttpServer: http.Server | undefined;
let shutdownStarted = false;

function isStdinEvent(event: NodeJS.Signals | 'end' | 'close'): boolean {
  return event === 'end' || event === 'close';
}

function registerShutdownTrigger(event: NodeJS.Signals | 'end' | 'close'): void {
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
    logRuntimeFailure(
      'shutdown_timeout',
      'process',
      'shutdown',
      `Shutdown timed out (${reason}), forcing exit.`,
    );
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
    await shutdownSearchWorkerPool();
    keepForceExitTimer = false;
  } catch (error: unknown) {
    logRuntimeFailure('shutdown_error', 'process', 'shutdown', error);
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
  let readOnly: boolean;
  let printConfig: boolean;
  let json: boolean;
  let subcommand: 'allow' | 'disallow' | 'list-allowed' | undefined;
  let subcommandPath: string | undefined;
  let client: string | undefined;
  let config: string | undefined;
  let serverName: string | undefined;
  let dryRun: boolean;

  try {
    const parsed = await parseArgs();
    ({
      allowedDirs,
      allowCwd,
      port,
      readOnly,
      printConfig,
      json,
      subcommand,
      subcommandPath,
      client,
      config,
      serverName,
      dryRun,
    } = parsed);
  } catch (error: unknown) {
    if (error instanceof CliExitError) {
      if (error.message.length > 0) {
        logRuntimeFailure('cli_exit', 'startup', 'parse_args', error.message);
      }
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }

  if (subcommand) {
    try {
      if (subcommand === 'allow') {
        if (!subcommandPath) {
          throw new CliExitError('Path is required', 1);
        }
        await allowPath(subcommandPath, { client, config, serverName, dryRun });
      } else if (subcommand === 'disallow') {
        if (!subcommandPath) {
          throw new CliExitError('Path is required', 1);
        }
        await disallowPath(subcommandPath, { client, config, serverName, dryRun });
      } else {
        const allowed = await listAllowedPaths({ client, config, serverName });
        if (json) {
          process.stdout.write(JSON.stringify(allowed, null, 2) + '\n');
        } else if (allowed.length === 0) {
          process.stdout.write('No directories are currently authorized.\n');
        } else {
          for (const p of allowed) {
            process.stdout.write(`${p}\n`);
          }
        }
      }
    } catch (error: unknown) {
      if (error instanceof CliExitError) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = error.exitCode;
        return;
      }
      throw error;
    }
    return;
  }

  if (printConfig) {
    const apiKey = process.env['FILESYSTEM_MCP_API_KEY'];
    await runPrintConfig({
      allowedDirs,
      allowCwd,
      readOnly,
      json,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
    return;
  }

  if (allowedDirs.length > 0) {
    console.error('Allowed directories (from CLI):');
    for (const dir of allowedDirs) {
      console.error(`- ${dir}`);
    }
  } else {
    console.error(
      `No directories specified via CLI. Will use MCP Roots${allowCwd ? ' or current working directory' : ''}.`,
    );
  }

  if (readOnly) {
    console.error('Read-only mode: mutating tools disabled.');
  }

  if (port !== undefined) {
    activeHttpServer = await startHttpServer(port, {
      allowCwd,
      cliAllowedDirs: allowedDirs,
      readOnly,
    });
  } else {
    const ctx = await createServer({
      allowCwd,
      cliAllowedDirs: allowedDirs,
      readOnly,
    });
    activeServer = ctx.mcp;
    await startServer(ctx);
  }
}

registerShutdownTrigger('SIGTERM');
registerShutdownTrigger('SIGINT');
registerShutdownTrigger('end');
registerShutdownTrigger('close');

process.once('unhandledRejection', (reason: unknown) => {
  logRuntimeFailure('unhandled_rejection', 'process', 'unhandledRejection', reason);
  void shutdown('unhandledRejection', 1);
});

process.once('uncaughtException', (error: Error) => {
  logRuntimeFailure('uncaught_exception', 'process', 'uncaughtException', error);
  void shutdown('uncaughtException', 1);
});

main().catch((error: unknown) => {
  logRuntimeFailure('fatal', 'startup', 'main', error);
  void shutdown('fatal', 1);
});
