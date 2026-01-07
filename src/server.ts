import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import packageJson from '../package.json' with { type: 'json' };
import {
  logMissingDirectoriesIfNeeded,
  recomputeAllowedDirectories,
  registerRootHandlers,
  type ServerOptions,
  setServerOptions,
} from './server/roots.js';
import { registerAllTools } from './tools/index.js';

export { parseArgs } from './server/cli.js';
const SERVER_VERSION = packageJson.version;

const currentDir = path.dirname(fileURLToPath(import.meta.url));
let serverInstructions = `
Filesystem Context MCP Server
(Detailed instructions failed to load - check logs)
`;
try {
  serverInstructions = await fs.readFile(
    path.join(currentDir, 'instructions.md'),
    'utf-8'
  );
} catch (error) {
  console.error(
    '[WARNING] Failed to load instructions.md:',
    error instanceof Error ? error.message : String(error)
  );
}

export function createServer(options: ServerOptions = {}): McpServer {
  setServerOptions(options);

  const server = new McpServer(
    {
      name: 'filesystem-context-mcp',
      version: SERVER_VERSION,
    },
    {
      instructions: serverInstructions || undefined,
      capabilities: {
        logging: {},
      },
    }
  );

  registerAllTools(server);

  return server;
}

export async function startServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();

  registerRootHandlers(server);

  await recomputeAllowedDirectories();

  await server.connect(transport);

  logMissingDirectoriesIfNeeded();
}
