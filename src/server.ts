import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Root } from '@modelcontextprotocol/sdk/types.js';

import type { ParseArgsResult, ServerOptions } from './config/types.js';
import { normalizePath } from './lib/path-utils.js';
import {
  getAllowedDirectories,
  getValidRootDirectories,
  setAllowedDirectories,
} from './lib/path-validation.js';
import { registerAllTools } from './tools/index.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };
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

const RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

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
    // Roots protocol may not be supported
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
    if (serverOptions.allowCwd) {
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
}
