import * as fs from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  InitializedNotificationSchema,
  RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Root } from '@modelcontextprotocol/sdk/types.js';

import { z } from 'zod';

import { formatUnknownErrorMessage } from '../lib/errors.js';
import {
  assertNotAborted,
  createTimedAbortSignal,
  withAbort,
} from '../lib/fs-helpers.js';
import {
  getAllowedDirectories,
  getValidRootDirectories,
  isPathWithinDirectories,
  normalizePath,
  setAllowedDirectoriesResolved,
} from '../lib/path-validation.js';
import { isRecord } from '../lib/type-guards.js';
import { type LoggingState, logToMcp } from './logging.js';
import type { ServerOptions } from './types.js';

const ROOTS_TIMEOUT_MS = 5000;
const ROOTS_DEBOUNCE_MS = 100;

function normalizeCLIDirectories(dirs: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const dir of dirs) {
    const trimmed = dir.trim();
    if (trimmed.length === 0) continue;
    normalized.push(normalizePath(trimmed));
  }
  return normalized;
}

const RootSchema = z.strictObject({
  uri: z.string(),
  name: z.string().optional(),
});

const RootsResponseSchema = z.object({
  roots: z.array(RootSchema).optional(),
});

function isRoot(value: unknown): value is Root {
  return isRecord(value) && typeof value['uri'] === 'string';
}

function normalizeRoot(root: Root): Root {
  return root.name ? { uri: root.uri, name: root.name } : { uri: root.uri };
}

function extractRoots(value: unknown): Root[] {
  const parsed = RootsResponseSchema.safeParse(value);
  if (!parsed.success || !parsed.data.roots) {
    return [];
  }
  const roots: Root[] = [];
  for (const root of parsed.data.roots) {
    if (isRoot(root)) {
      roots.push(normalizeRoot(root));
    }
  }
  return roots;
}

async function resolveRootDirectories(roots: Root[]): Promise<string[]> {
  if (roots.length === 0) return [];
  const { signal, cleanup } = createTimedAbortSignal(
    undefined,
    ROOTS_TIMEOUT_MS
  );
  try {
    return await getValidRootDirectories(roots, signal);
  } finally {
    cleanup();
  }
}

async function isRootWithinBaseline(
  normalizedRoot: string,
  baseline: readonly string[],
  signal?: AbortSignal
): Promise<boolean> {
  if (!isPathWithinDirectories(normalizedRoot, baseline)) {
    return false;
  }

  try {
    assertNotAborted(signal);
    const realPath = await withAbort(fs.realpath(normalizedRoot), signal);
    const normalizedReal = normalizePath(realPath);
    return isPathWithinDirectories(normalizedReal, baseline);
  } catch {
    return false;
  }
}

async function filterRootsWithinBaseline(
  roots: readonly string[],
  baseline: readonly string[],
  signal?: AbortSignal
): Promise<string[]> {
  const normalizedBaseline = normalizeCLIDirectories(baseline);
  const normalizedRoots = roots.map(normalizePath);
  if (normalizedRoots.length === 0) return [];

  const results = await Promise.allSettled(
    normalizedRoots.map((normalizedRoot) =>
      isRootWithinBaseline(normalizedRoot, normalizedBaseline, signal)
    )
  );

  return normalizedRoots.filter((_, i) => {
    const result = results[i];
    return result?.status === 'fulfilled' && result.value;
  });
}

export class RootsManager {
  private rootsUpdateTimeout: ReturnType<typeof setTimeout> | undefined;
  private rootDirectories: string[] = [];
  private clientInitialized = false;
  // Set to true when an update is in progress, to prevent concurrent executions. If a change arrives while true, we queue a single retry after completion to ensure the last-known state is applied. This
  private updatingRoots = false;
  // If an update is in progress and a change arrives, we set this flag to ensure we run another update after completion to apply the latest state
  private pendingRootsUpdate = false;
  private readonly options: ServerOptions;
  readonly loggingState: LoggingState;

  constructor(options: ServerOptions, loggingState: LoggingState) {
    this.options = options;
    this.loggingState = loggingState;
  }

  isInitialized(): boolean {
    return this.clientInitialized;
  }

  destroy(): void {
    if (this.rootsUpdateTimeout) {
      clearTimeout(this.rootsUpdateTimeout);
      this.rootsUpdateTimeout = undefined;
    }
  }

  logMissingDirectoriesIfNeeded(server: McpServer): void {
    if (getAllowedDirectories().length === 0) {
      this.logMissingDirectories(server);
    }
  }

  registerHandlers(server: McpServer): void {
    server.server.setNotificationHandler(
      InitializedNotificationSchema,
      async () => {
        this.clientInitialized = true;
        await this.updateRootsFromClient(server);
      }
    );

    server.server.setNotificationHandler(
      RootsListChangedNotificationSchema,
      () => {
        if (!this.clientInitialized) return;
        this.scheduleRootsUpdate(server);
      }
    );
  }

  async recomputeAllowedDirectories(): Promise<void> {
    const cliAllowedDirs = normalizeCLIDirectories(
      this.options.cliAllowedDirs ?? []
    );
    const allowCwd = Boolean(this.options.allowCwd);
    const allowCwdDirs = allowCwd ? [normalizePath(process.cwd())] : [];
    const baseline = [...cliAllowedDirs, ...allowCwdDirs];
    const { signal, cleanup } = createTimedAbortSignal(
      undefined,
      ROOTS_TIMEOUT_MS
    );
    try {
      const rootsToInclude =
        baseline.length > 0
          ? await filterRootsWithinBaseline(
              this.rootDirectories,
              baseline,
              signal
            )
          : this.rootDirectories;

      const combined = [...baseline, ...rootsToInclude];
      await setAllowedDirectoriesResolved(combined, signal);
    } finally {
      cleanup();
    }
  }

  private scheduleRootsUpdate(server: McpServer): void {
    if (this.rootsUpdateTimeout) {
      this.rootsUpdateTimeout.refresh();
      return;
    }

    this.rootsUpdateTimeout = setTimeout(() => {
      this.rootsUpdateTimeout = undefined;
      void this.updateRootsFromClient(server);
    }, ROOTS_DEBOUNCE_MS);
    this.rootsUpdateTimeout.unref();
  }

  private logMissingDirectories(server?: McpServer): void {
    if (this.options.allowCwd) {
      logToMcp(
        server,
        'notice',
        'No allowed directories specified. Using the current working directory as an allowed directory.',
        this.loggingState.minimumLevel
      );
      return;
    }

    logToMcp(
      server,
      'warning',
      'No allowed directories specified. Please provide directories as command-line arguments or enable --allow-cwd to use the current working directory.',
      this.loggingState.minimumLevel
    );
  }

  private async updateRootsFromClient(server: McpServer): Promise<void> {
    // Guard against concurrent executions: if one is already running, queue a
    // single retry so the last-known state is always applied after completion.
    if (this.updatingRoots) {
      this.pendingRootsUpdate = true;
      return;
    }
    this.updatingRoots = true;
    try {
      const clientCapabilities = server.server.getClientCapabilities();
      if (!clientCapabilities?.roots) {
        this.rootDirectories = [];
      } else {
        const rootsResult = await server.server.listRoots(undefined, {
          timeout: ROOTS_TIMEOUT_MS,
        });
        const roots = extractRoots(rootsResult);
        this.rootDirectories = await resolveRootDirectories(roots);
      }
    } catch (error) {
      logToMcp(
        server,
        'debug',
        `[DEBUG] MCP Roots protocol unavailable or failed: ${formatUnknownErrorMessage(error)}`,
        this.loggingState.minimumLevel
      );
    } finally {
      await this.recomputeAllowedDirectories();
      this.updatingRoots = false;
      // If a change arrived while we were running, apply it now.
      if (this.pendingRootsUpdate) {
        this.pendingRootsUpdate = false;
        void this.updateRootsFromClient(server);
      }
    }
  }
}
