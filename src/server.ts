import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  InitializedNotificationSchema,
  RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Root } from '@modelcontextprotocol/sdk/types.js';

import packageJson from '../package.json' with { type: 'json' };
import { normalizePath } from './lib/path-utils.js';
import {
  getAllowedDirectories,
  getValidRootDirectories,
  isPathWithinDirectories,
  setAllowedDirectoriesResolved,
} from './lib/path-validation.js';
import { normalizeAllowedDirectories } from './server/cli.js';
import { registerAllTools } from './tools/index.js';

export { parseArgs } from './server/cli.js';
const SERVER_VERSION = packageJson.version;
const ROOTS_TIMEOUT_MS = 5000;

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

let serverOptions: ServerOptions = {};
let rootDirectories: string[] = [];
let clientInitialized = false;

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
    const rootsResult = await server.server.listRoots(undefined, {
      timeout: ROOTS_TIMEOUT_MS,
    });
    const rootsResultUnknown: unknown = rootsResult;
    const rawRoots =
      typeof rootsResultUnknown === 'object' &&
      rootsResultUnknown !== null &&
      'roots' in rootsResultUnknown
        ? (rootsResultUnknown as { roots?: unknown }).roots
        : undefined;
    const roots = Array.isArray(rawRoots) ? rawRoots.filter(isRoot) : [];

    rootDirectories =
      roots.length > 0 ? await getValidRootDirectories(roots) : [];
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

function isRoot(value: unknown): value is Root {
  return (
    value !== null &&
    typeof value === 'object' &&
    'uri' in value &&
    typeof value.uri === 'string'
  );
}

async function filterRootsWithinBaseline(
  roots: readonly string[],
  baseline: readonly string[]
): Promise<string[]> {
  const normalizedBaseline = normalizeAllowedDirectories(baseline);
  const filtered: string[] = [];

  for (const root of roots) {
    const normalizedRoot = normalizePath(root);
    const isValid = await isRootWithinBaseline(
      normalizedRoot,
      normalizedBaseline
    );
    if (isValid) filtered.push(normalizedRoot);
  }

  return filtered;
}

async function isRootWithinBaseline(
  normalizedRoot: string,
  baseline: readonly string[]
): Promise<boolean> {
  if (!isPathWithinDirectories(normalizedRoot, baseline)) {
    return false;
  }

  try {
    const realPath = await fs.realpath(normalizedRoot);
    const normalizedReal = normalizePath(realPath);
    return isPathWithinDirectories(normalizedReal, baseline);
  } catch {
    return false;
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
    InitializedNotificationSchema,
    async () => {
      clientInitialized = true;
      await updateRootsFromClient(server);
    }
  );

  server.server.setNotificationHandler(
    RootsListChangedNotificationSchema,
    async () => {
      if (!clientInitialized) return;
      await updateRootsFromClient(server);
    }
  );

  await recomputeAllowedDirectories();

  await server.connect(transport);

  const dirs = getAllowedDirectories();
  if (dirs.length === 0) {
    logMissingDirectories(serverOptions);
  }
}
