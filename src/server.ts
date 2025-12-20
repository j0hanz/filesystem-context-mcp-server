import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Root } from '@modelcontextprotocol/sdk/types.js';

import packageJson from '../package.json' with { type: 'json' };
import { normalizePath } from './lib/path-utils.js';
import {
  getAllowedDirectories,
  getValidRootDirectories,
  RESERVED_DEVICE_NAMES,
  setAllowedDirectoriesResolved,
} from './lib/path-validation.js';
import { registerAllTools } from './tools/index.js';

const SERVER_VERSION = packageJson.version;

const currentDir = path.dirname(fileURLToPath(import.meta.url));
let serverInstructions = '';
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

function validateCliPath(inputPath: string): void {
  if (inputPath.includes('\0')) {
    throw new Error('Path contains null bytes');
  }

  if (process.platform === 'win32') {
    const basename = path.basename(inputPath).split('.')[0]?.toUpperCase();
    if (basename && RESERVED_DEVICE_NAMES.has(basename)) {
      throw new Error(`Reserved device name not allowed: ${basename}`);
    }
  }
}

export async function parseArgs(): Promise<ParseArgsResult> {
  const args = process.argv.slice(2);

  const allowCwdIndex = args.indexOf('--allow-cwd');
  const allowCwd = allowCwdIndex !== -1;
  if (allowCwd) {
    args.splice(allowCwdIndex, 1);
  }

  if (args.length === 0) {
    return { allowedDirs: [], allowCwd };
  }

  const validatedDirs: string[] = [];

  for (const dir of args) {
    validateCliPath(dir);
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

let serverOptions: ServerOptions = {};
let rootDirectories: string[] = [];

interface ParseArgsResult {
  allowedDirs: string[];
  allowCwd: boolean;
}

interface ServerOptions {
  allowCwd?: boolean;
  cliAllowedDirs?: string[];
}

function logMissingDirectories(options: ServerOptions): void {
  if (options.allowCwd) {
    console.error('No directories specified. Using current working directory:');
    return;
  }

  console.error(
    'WARNING: No directories configured. Use --allow-cwd flag or specify directories via CLI/roots protocol.'
  );
  console.error(
    'The server will not be able to access any files until directories are configured.'
  );
}

async function recomputeAllowedDirectories(): Promise<void> {
  const cliAllowedDirs = serverOptions.cliAllowedDirs ?? [];
  const allowCwd = serverOptions.allowCwd === true;
  const allowCwdDirs = allowCwd ? [normalizePath(process.cwd())] : [];

  await setAllowedDirectoriesResolved([
    ...cliAllowedDirs,
    ...allowCwdDirs,
    ...rootDirectories,
  ]);
}

async function updateRootsFromClient(server: McpServer): Promise<void> {
  try {
    const rootsResult = await server.server.listRoots();
    rootDirectories =
      rootsResult.roots.length > 0
        ? await getValidRootDirectories(rootsResult.roots as Root[])
        : [];
  } catch (error) {
    console.error(
      '[DEBUG] MCP Roots protocol unavailable or failed:',
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    await recomputeAllowedDirectories();
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

  await updateRootsFromClient(server);

  const dirs = getAllowedDirectories();
  if (dirs.length === 0) {
    logMissingDirectories(serverOptions);
  }
}
