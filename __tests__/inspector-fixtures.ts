import { writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { normalizePath } from '../src/core/path.js';
import { startHttpServer } from '../src/transport.js';
import { cleanupTestRoot, createTestRoot } from './helpers.js';

export interface InspectorServerConfigEntry {
  command?: string;
  args?: string[];
  type?: 'stdio' | 'http' | 'sse';
  url?: string;
  protocolEra?: 'modern' | 'legacy' | 'auto';
  headers?: Record<string, string>;
  roots?: { uri: string; name?: string }[];
  env?: Record<string, string>;
}

export interface InspectorConfigFile {
  mcpServers: Record<string, InspectorServerConfigEntry>;
}

/**
 * Create an isolated temp root directory for Inspector test suites.
 */
export const createInspectorTestRoot = createTestRoot;

/**
 * Remove an isolated test root directory.
 */
export const cleanupInspectorTestRoot = cleanupTestRoot;

/**
 * Create a temporary configuration file with mcpServers for testing --config.
 */
export async function createInspectorConfigFile(
  filePath: string,
  serverName: string,
  config: InspectorServerConfigEntry,
): Promise<string> {
  const fileContent: InspectorConfigFile = {
    mcpServers: {
      [serverName]: config,
    },
  };
  await writeFile(filePath, JSON.stringify(fileContent, null, 2), 'utf-8');
  return normalizePath(filePath);
}

/**
 * Returns standard invocation command for filesystem-mcp stdio server.
 */
export function getStdioServerCommand(): string[] {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  return [process.execPath, '--import', 'tsx', join(repoRoot, 'src/index.ts')];
}

let savedApiKey: string | undefined;

/**
 * Helper to launch in-process HTTP server for HTTP inspector tests.
 */
export async function startInspectorHttp(
  port: number,
  allowedDirs: string[],
  options: { readOnly?: boolean; apiKey?: string } = {},
): Promise<Server> {
  savedApiKey = process.env['API_KEY'];
  if (options.apiKey !== undefined) {
    process.env['API_KEY'] = options.apiKey;
  }
  return startHttpServer(port, {
    cliAllowedDirs: allowedDirs,
    ...(options.readOnly ? { readOnly: true } : {}),
  });
}

/**
 * Helper to extract dynamically assigned port from running HTTP server.
 */
export function getInspectorHttpPort(server: Server): number {
  const addr = server.address() as AddressInfo | null;
  return addr ? addr.port : 0;
}

/**
 * Helper to close HTTP server and restore environment.
 */
export async function stopInspectorHttp(server: Server): Promise<void> {
  if (savedApiKey !== undefined) {
    process.env['API_KEY'] = savedApiKey;
  } else {
    delete process.env['API_KEY'];
  }
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}
