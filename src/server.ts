import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Root } from '@modelcontextprotocol/sdk/types.js';

import type { ParseArgsResult, ServerOptions } from './config/types.js';
import { setMcpServerInstance } from './lib/mcp-logger.js';
import { normalizePath } from './lib/path-utils.js';
import {
  getAllowedDirectories,
  getValidRootDirectories,
  setAllowedDirectories,
} from './lib/path-validation.js';
import { registerAllPrompts } from './prompts/index.js';
import { registerAllResources } from './resources/index.js';
import { registerAllTools } from './tools/index.js';

// Get version from package.json
const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };
const SERVER_VERSION = packageJson.version;

// Load server instructions
const currentDir = path.dirname(fileURLToPath(import.meta.url));
let serverInstructions = '';
try {
  serverInstructions = await fs.readFile(
    path.join(currentDir, 'instructions.md'),
    'utf-8'
  );
} catch {
  // Instructions file not found - continue without instructions
}

export async function parseArgs(): Promise<ParseArgsResult> {
  const args = process.argv.slice(2);

  // Check for --allow-cwd flag
  const allowCwdIndex = args.indexOf('--allow-cwd');
  const allowCwd = allowCwdIndex !== -1;
  if (allowCwd) {
    args.splice(allowCwdIndex, 1);
  }

  // Allow empty args - will fall back to CWD or roots protocol
  if (args.length === 0) {
    return { allowedDirs: [], allowCwd };
  }

  const validatedDirs: string[] = [];

  for (const dir of args) {
    const normalized = normalizePath(dir);

    try {
      const stats = await fs.stat(normalized);
      if (!stats.isDirectory()) {
        throw new Error(`Error: '${dir}' is not a directory`);
      }
      validatedDirs.push(normalized);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Error:')) {
        throw error;
      }
      throw new Error(`Error: Cannot access directory '${dir}'`);
    }
  }

  return { allowedDirs: validatedDirs, allowCwd };
}

// Store server options for use in startServer
let serverOptions: ServerOptions = {};

async function updateRootsFromClient(server: McpServer): Promise<void> {
  try {
    const rootsResult = await server.server.listRoots();
    if (rootsResult.roots.length > 0) {
      const validDirs = await getValidRootDirectories(
        rootsResult.roots as Root[]
      );
      if (validDirs.length > 0) {
        const currentDirs = getAllowedDirectories();
        const mergedDirs = [...new Set([...currentDirs, ...validDirs])];
        setAllowedDirectories(mergedDirs);
      }
    }
  } catch {
    // Ignore errors - roots protocol may not be supported
  }
}

export function createServer(options: ServerOptions = {}): McpServer {
  serverOptions = options;

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
  registerAllPrompts(server);
  registerAllResources(server);

  return server;
}

export async function startServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();

  server.server.setNotificationHandler(
    RootsListChangedNotificationSchema,
    async () => {
      await updateRootsFromClient(server);
    }
  );

  await server.connect(transport);

  // Set server instance for MCP logging support
  setMcpServerInstance(server);

  // Update allowed directories from roots protocol if available
  void updateRootsFromClient(server).then((): void => {
    const dirs = getAllowedDirectories();
    if (dirs.length === 0) {
      if (serverOptions.allowCwd) {
        // Fall back to current working directory only if explicitly allowed
        const cwd = normalizePath(process.cwd());
        setAllowedDirectories([cwd]);
        console.error(
          'No directories specified. Using current working directory:'
        );
      } else {
        console.error(
          'WARNING: No directories configured. Use --allow-cwd flag or specify directories via CLI/roots protocol.'
        );
        console.error(
          'The server will not be able to access any files until directories are configured.'
        );
      }
    }
  });
}
