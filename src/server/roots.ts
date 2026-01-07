import * as fs from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  InitializedNotificationSchema,
  RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Root } from '@modelcontextprotocol/sdk/types.js';

import { normalizePath } from '../lib/path-utils.js';
import {
  getAllowedDirectories,
  isPathWithinDirectories,
  setAllowedDirectoriesResolved,
} from '../lib/path-validation/allowed-directories.js';
import { getValidRootDirectories } from '../lib/path-validation/roots.js';
import { normalizeAllowedDirectories } from './cli.js';

const ROOTS_TIMEOUT_MS = 5000;
const ROOTS_DEBOUNCE_MS = 100;

let rootsUpdateTimeout: ReturnType<typeof setTimeout> | undefined;
let rootDirectories: string[] = [];
let clientInitialized = false;
let serverOptions: ServerOptions = {};

export interface ServerOptions {
  allowCwd?: boolean;
  cliAllowedDirs?: string[];
}

export function setServerOptions(options: ServerOptions): void {
  serverOptions = options;
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

export async function recomputeAllowedDirectories(): Promise<void> {
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

export function registerRootHandlers(server: McpServer): void {
  server.server.setNotificationHandler(
    InitializedNotificationSchema,
    async () => {
      clientInitialized = true;
      await updateRootsFromClient(server);
    }
  );

  server.server.setNotificationHandler(
    RootsListChangedNotificationSchema,
    () => {
      if (!clientInitialized) return;
      if (rootsUpdateTimeout) clearTimeout(rootsUpdateTimeout);
      rootsUpdateTimeout = setTimeout(() => {
        void updateRootsFromClient(server);
      }, ROOTS_DEBOUNCE_MS);
    }
  );
}

export function logMissingDirectoriesIfNeeded(): void {
  if (getAllowedDirectories().length === 0) {
    logMissingDirectories(serverOptions);
  }
}
