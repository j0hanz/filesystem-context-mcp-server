import * as fs from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Root } from '@modelcontextprotocol/sdk/types.js';
import {
  InitializedNotificationSchema,
  RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { formatUnknownErrorMessage } from '../lib/errors.js';
import {
  assertNotAborted,
  createTimedAbortSignal,
  withAbort,
} from '../lib/fs-helpers.js';
import {
  type AllowedDirectoriesState,
  getValidRootDirectories,
  isPathWithinDirectories,
  normalizePath,
  resolveAllowedDirectoriesState,
  setAllowedDirectoriesStateResolved,
} from '../lib/paths.js';
import { debounce, isRecord } from '../lib/utils.js';

import { type LoggingState, logToMcp } from './bootstrap.js';
import type { ServerOptions } from './bootstrap.js';

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
  private _debouncedUpdate:
    | { (server: McpServer): void; cancel: () => void }
    | undefined;
  private rootDirectories: string[] = [];
  private allowedDirectoriesState: AllowedDirectoriesState = {
    primary: [],
    expanded: [],
  };
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
    if (this._debouncedUpdate) {
      this._debouncedUpdate.cancel();
      this._debouncedUpdate = undefined;
    }
  }

  getAllowedDirectoriesState(): AllowedDirectoriesState {
    return {
      primary: [...this.allowedDirectoriesState.primary],
      expanded: [...this.allowedDirectoriesState.expanded],
    };
  }

  logMissingDirectoriesIfNeeded(server: McpServer): void {
    if (this.allowedDirectoriesState.expanded.length === 0) {
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
      const nextState = await resolveAllowedDirectoriesState(combined, signal);
      this.allowedDirectoriesState = nextState;
      setAllowedDirectoriesStateResolved(nextState);
    } finally {
      cleanup();
    }
  }

  private scheduleRootsUpdate(server: McpServer): void {
    this._debouncedUpdate ??= debounce((s: McpServer) => {
      void this.updateRootsFromClient(s);
    }, ROOTS_DEBOUNCE_MS);
    this._debouncedUpdate(server);
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
