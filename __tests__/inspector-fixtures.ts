import { writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';

import { normalizePath } from '../src/core/path-utils.js';
import { startHttpServer } from '../src/transport.js';

export interface InspectorServerConfigEntry {
  command?: string;
  args?: string[];
  type?: 'stdio' | 'http';
  url?: string;
  protocolEra?: 'modern' | 'legacy' | 'auto';
  headers?: Record<string, string>;
  roots?: { uri: string; name?: string }[];
  env?: Record<string, string>;
}

/**
 * Create a temporary configuration file with mcpServers for testing --config.
 */
export async function createInspectorConfigFile(
  filePath: string,
  serverName: string,
  config: InspectorServerConfigEntry,
): Promise<string> {
  await writeFile(
    filePath,
    JSON.stringify({ mcpServers: { [serverName]: config } }, null, 2),
    'utf-8',
  );
  return normalizePath(filePath);
}

/**
 * Helper to launch in-process HTTP server for HTTP inspector tests. The API key
 * goes in as config, so two servers can run at once without fighting over one
 * process-wide env slot.
 */
export async function startInspectorHttp(
  port: number,
  allowedDirs: string[],
  options: { readOnly?: boolean; apiKey?: string } = {},
): Promise<Server> {
  return startHttpServer(
    port,
    {
      cliAllowedDirs: allowedDirs,
      ...(options.readOnly ? { readOnly: true } : {}),
    },
    { ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}) },
  );
}
