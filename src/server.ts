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
  isPathWithinDirectories,
  RESERVED_DEVICE_NAMES,
  setAllowedDirectoriesResolved,
} from './lib/path-validation.js';
import { registerAllTools } from './tools/index.js';

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

function validateCliPath(inputPath: string): void {
  if (inputPath.includes('\0')) {
    throw new Error('Path contains null bytes');
  }

  const reserved = getReservedCliDeviceName(inputPath);
  if (reserved) {
    throw new Error(`Reserved device name not allowed: ${reserved}`);
  }
}

function getReservedCliDeviceName(inputPath: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const basename = path.basename(inputPath).split('.')[0]?.toUpperCase();
  if (!basename) return undefined;
  return RESERVED_DEVICE_NAMES.has(basename) ? basename : undefined;
}

function extractAllowCwd(args: string[]): {
  allowCwd: boolean;
  rest: string[];
} {
  const allowCwdIndex = args.indexOf('--allow-cwd');
  if (allowCwdIndex === -1) {
    return { allowCwd: false, rest: args };
  }

  const rest = [...args];
  rest.splice(allowCwdIndex, 1);
  return { allowCwd: true, rest };
}

async function validateDirectoryPath(inputPath: string): Promise<string> {
  validateCliPath(inputPath);
  const normalized = normalizePath(inputPath);

  try {
    const stats = await fs.stat(normalized);
    if (!stats.isDirectory()) {
      throw new Error(`Error: '${inputPath}' is not a directory`);
    }
    return normalized;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Error:')) {
      throw error;
    }
    throw new Error(`Error: Cannot access directory '${inputPath}'`);
  }
}

async function normalizeCliDirectories(args: string[]): Promise<string[]> {
  const validatedDirs: string[] = [];

  for (const dir of args) {
    validatedDirs.push(await validateDirectoryPath(dir));
  }

  return validatedDirs;
}

export async function parseArgs(): Promise<ParseArgsResult> {
  const argv = process.argv.slice(2);
  const { allowCwd, rest } = extractAllowCwd(argv);
  const allowedDirs =
    rest.length > 0 ? await normalizeCliDirectories(rest) : [];

  return { allowedDirs, allowCwd };
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
  const cliAllowedDirs = normalizeAllowedDirectories(
    serverOptions.cliAllowedDirs ?? []
  );
  const allowCwd = serverOptions.allowCwd === true;
  const allowCwdDirs = allowCwd ? [normalizePath(process.cwd())] : [];
  const baseline = [...cliAllowedDirs, ...allowCwdDirs];
  const rootsToInclude =
    baseline.length > 0
      ? await filterRootsWithinBaseline(rootDirectories, baseline)
      : rootDirectories;

  await setAllowedDirectoriesResolved([...baseline, ...rootsToInclude]);
}

async function updateRootsFromClient(server: McpServer): Promise<void> {
  try {
    const rootsResult = await server.server.listRoots();
    const rawRoots = (rootsResult as unknown as { roots?: unknown }).roots;
    const roots = Array.isArray(rawRoots) ? rawRoots : [];

    rootDirectories =
      roots.length > 0 ? await getValidRootDirectories(roots as Root[]) : [];
  } catch (error) {
    rootDirectories = [];
    console.error(
      '[DEBUG] MCP Roots protocol unavailable or failed:',
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    await recomputeAllowedDirectories();
  }
}

function normalizeAllowedDirectories(dirs: string[]): string[] {
  return dirs
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0)
    .map(normalizePath);
}

async function filterRootsWithinBaseline(
  roots: string[],
  baseline: string[]
): Promise<string[]> {
  const normalizedBaseline = normalizeAllowedDirectories(baseline);
  const filtered: string[] = [];

  for (const root of roots) {
    const normalizedRoot = normalizePath(root);
    if (!isPathWithinDirectories(normalizedRoot, normalizedBaseline)) {
      continue;
    }

    try {
      const realPath = await fs.realpath(normalizedRoot);
      const normalizedReal = normalizePath(realPath);
      if (!isPathWithinDirectories(normalizedReal, normalizedBaseline)) {
        continue;
      }
    } catch {
      continue;
    }

    filtered.push(normalizedRoot);
  }

  return filtered;
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
