import {
  type Implementation,
  InMemoryTaskMessageQueue,
  McpServer,
  type Root,
  type ServerCapabilities,
  type SetLevelRequestParams,
} from '@modelcontextprotocol/server';

import { channel } from 'node:diagnostics_channel';
import { readFile, realpath } from 'node:fs/promises';

import { assertNotAborted, createTimedAbortSignal, withAbort } from './core/concurrency.js';
import { formatUnknownErrorMessage } from './core/errors.js';
import {
  createLoggingState,
  Logger,
  type LoggingState,
  LogRouter,
  logToMcp,
} from './core/observability.js';
import {
  getValidRootDirectories,
  isPathWithinDirectories,
  normalizePath,
  PathGuard,
  resolveAllowedDirectoriesState,
} from './core/path.js';
import { createInMemoryResourceStore, type ResourceStore } from './core/store.js';
import {
  debounce,
  getInitHandshakeTimeoutMs,
  LOG_LEVEL,
  SENSITIVE_FILE_DENYLIST,
} from './core/util.js';
import { pkgInfo } from './pkg-info.js';
import { registerAllPrompts } from './prompts.js';
import {
  registerAllResources,
  type ResourcesHandle,
  serverInstructionsContent,
} from './resources.js';
import type { EventedTaskStore } from './tasks.js';
import { createTaskStore, TaskOrchestrator } from './tasks.js';
import { registerAllTools } from './tools.js';
import { type IconInfo, withDefaultIcons } from './tools/_helpers.js';

const ROOTS_TIMEOUT_MS = 5000;
const ROOTS_DEBOUNCE_MS = 100;

const LIFECYCLE_CHANNEL = channel('filesystem-mcp:lifecycle');

export interface ServerOptions {
  allowCwd?: boolean;
  cliAllowedDirs?: string[];
}

function normalizeCLIDirectories(dirs: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const dir of dirs) {
    const trimmed = dir.trim();
    if (trimmed.length === 0) continue;
    normalized.push(normalizePath(trimmed));
  }
  return normalized;
}

async function resolveRootDirectories(roots: Root[]): Promise<string[]> {
  if (roots.length === 0) return [];
  const { signal, cleanup } = createTimedAbortSignal(undefined, ROOTS_TIMEOUT_MS);
  try {
    return await getValidRootDirectories(roots, signal);
  } finally {
    cleanup();
  }
}

async function isRootWithinBaseline(
  normalizedRoot: string,
  baseline: readonly string[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (!isPathWithinDirectories(normalizedRoot, baseline)) {
    return false;
  }

  try {
    assertNotAborted(signal);
    const realPath = await withAbort(realpath(normalizedRoot), signal);
    const normalizedReal = normalizePath(realPath);
    return isPathWithinDirectories(normalizedReal, baseline);
  } catch {
    return false;
  }
}

async function filterRootsWithinBaseline(
  roots: readonly string[],
  baseline: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const normalizedBaseline = normalizeCLIDirectories(baseline);
  const normalizedRoots = roots.map(normalizePath);
  if (normalizedRoots.length === 0) return [];

  const results = await Promise.allSettled(
    normalizedRoots.map((normalizedRoot) =>
      isRootWithinBaseline(normalizedRoot, normalizedBaseline, signal),
    ),
  );

  return normalizedRoots.filter((_, i) => {
    const result = results[i];
    return result?.status === 'fulfilled' && result.value;
  });
}

export class RootsManager {
  private _debouncedUpdate: { (server: McpServer): void; cancel: () => void } | undefined;
  private rootDirectories: string[] = [];
  readonly pathGuard: PathGuard = new PathGuard(SENSITIVE_FILE_DENYLIST);
  private clientInitialized = false;
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  // Guard concurrent root refreshes; if one is already running we queue one
  // replay so the last-known state still gets applied after completion.
  private updatingRoots = false;
  // Tracks whether a roots change arrived while the previous refresh ran.
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
    if (this.initTimer) {
      clearTimeout(this.initTimer);
      this.initTimer = undefined;
    }
    if (this._debouncedUpdate) {
      this._debouncedUpdate.cancel();
      this._debouncedUpdate = undefined;
    }
  }

  logMissingDirectoriesIfNeeded(server: McpServer): void {
    if (this.pathGuard.getAllowedDirectories().length === 0) {
      this.logMissingDirectories(server);
    }
  }

  registerHandlers(server: McpServer, onInitTimeout?: () => void): void {
    const initHandshakeTimeoutMs = getInitHandshakeTimeoutMs();

    server.server.setNotificationHandler('notifications/initialized', async () => {
      if (this.initTimer) {
        clearTimeout(this.initTimer);
        this.initTimer = undefined;
      }
      this.clientInitialized = true;
      await this.updateRootsFromClient(server);
    });

    server.server.setNotificationHandler('notifications/roots/list_changed', () => {
      if (!this.clientInitialized) return;
      this.scheduleRootsUpdate(server);
    });

    this.initTimer = setTimeout(() => {
      if (!this.clientInitialized) {
        if (LIFECYCLE_CHANNEL.hasSubscribers) {
          LIFECYCLE_CHANNEL.publish({
            phase: 'init_timeout',
            timeoutMs: initHandshakeTimeoutMs,
          });
        }
        logToMcp(
          server,
          'warning',
          `Client did not send notifications/initialized within ${String(initHandshakeTimeoutMs)}ms`,
          this.loggingState.minimumLevel,
        );
        onInitTimeout?.();
      }
      this.initTimer = undefined;
    }, initHandshakeTimeoutMs);
    this.initTimer.unref();
  }

  async recomputeAllowedDirectories(): Promise<void> {
    const cliAllowedDirs = normalizeCLIDirectories(this.options.cliAllowedDirs ?? []);
    const allowCwd = Boolean(this.options.allowCwd);
    const allowCwdDirs = allowCwd ? [normalizePath(process.cwd())] : [];
    const baseline = [...cliAllowedDirs, ...allowCwdDirs];
    const { signal, cleanup } = createTimedAbortSignal(undefined, ROOTS_TIMEOUT_MS);
    try {
      const rootsToInclude =
        baseline.length > 0
          ? await filterRootsWithinBaseline(this.rootDirectories, baseline, signal)
          : this.rootDirectories;

      const combined = [...baseline, ...rootsToInclude];
      const nextState = await resolveAllowedDirectoriesState(combined, signal);
      this.pathGuard.initialize(nextState);
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
        this.loggingState.minimumLevel,
      );
      return;
    }

    logToMcp(
      server,
      'warning',
      'No allowed directories specified. Please provide directories as command-line arguments or enable --allow-cwd to use the current working directory.',
      this.loggingState.minimumLevel,
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
        const roots: Root[] = rootsResult.roots
          .filter((r) => r.uri.startsWith('file://'))
          .map((r) => (r.name ? { uri: r.uri, name: r.name } : { uri: r.uri }));
        this.rootDirectories = await resolveRootDirectories(roots);
      }
    } catch (error) {
      logToMcp(
        server,
        'debug',
        `[DEBUG] MCP Roots protocol unavailable or failed: ${formatUnknownErrorMessage(error)}`,
        this.loggingState.minimumLevel,
      );
    } finally {
      await this.recomputeAllowedDirectories();
      Logger.info(
        `Roots updated: ${this.rootDirectories.length} root(s), ${this.pathGuard.getAllowedDirectories().length} allowed dir(s)`,
      );
      this.updatingRoots = false;
      // If a change arrived while we were running, apply it now.
      if (this.pendingRootsUpdate) {
        this.pendingRootsUpdate = false;
        void this.updateRootsFromClient(server);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// bootstrap
// ═══════════════════════════════════════════════════════════════

interface CapabilityOptions {
  enablePromptListChanged?: boolean;
  enableTaskToolRequests?: boolean;
}

function buildServerCapabilities(options: CapabilityOptions = {}): ServerCapabilities {
  const capabilities: ServerCapabilities = {
    logging: {},
    resources: { subscribe: true, listChanged: true },
    tools: {},
    prompts: options.enablePromptListChanged ? { listChanged: true } : {},
    completions: {},
    extensions: {},
  };

  if (options.enableTaskToolRequests) {
    capabilities.tasks = {
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
    };
  }

  return capabilities;
}

export const logRouter = LogRouter.global();

const {
  version: SERVER_VERSION,
  description: SERVER_DESCRIPTION,
  homepage: SERVER_HOMEPAGE,
} = pkgInfo;

export class FilesystemServerContext {
  public readonly mcp: McpServer;
  public readonly roots: RootsManager;
  public readonly resources: ResourceStore;
  public readonly resourcesHandle: ResourcesHandle;

  constructor(
    mcp: McpServer,
    roots: RootsManager,
    resources: ResourceStore,
    resourcesHandle: ResourcesHandle,
  ) {
    this.mcp = mcp;
    this.roots = roots;
    this.resources = resources;
    this.resourcesHandle = resourcesHandle;
  }

  async close(): Promise<void> {
    this.resourcesHandle.destroy();
    this.roots.destroy();
    logRouter.detachStdio();
    await this.mcp.close();
  }
}

let cachedIconInfo: Promise<IconInfo | undefined> | undefined;

function getLocalIconInfo(): Promise<IconInfo | undefined> {
  if (cachedIconInfo !== undefined) {
    return cachedIconInfo;
  }

  cachedIconInfo = (async () => {
    const name = 'logo.svg';
    const mime = 'image/svg+xml';
    // From src/server.ts, ../assets/ resolves to the root-level assets/ folder
    const candidates = [`../assets/${name}`];

    for (const candidate of candidates) {
      try {
        const iconPath = new URL(candidate, import.meta.url);
        const buffer = await readFile(iconPath);
        return {
          src: `data:${mime};base64,${buffer.toString('base64')}`,
          mimeType: mime,
        };
      } catch {
        // Try next candidate.
      }
    }

    return undefined;
  })();

  return cachedIconInfo;
}

export async function createServer(
  options: ServerOptions & { isInitialized?: () => boolean } = {},
): Promise<FilesystemServerContext> {
  const resourceStore = createInMemoryResourceStore();
  const localIcon = await getLocalIconInfo();
  const capabilities = buildServerCapabilities({
    enablePromptListChanged: false,
    enableTaskToolRequests: true,
  });

  let taskStore: EventedTaskStore | undefined;
  if (capabilities.tasks) {
    taskStore = createTaskStore();
    capabilities.tasks = {
      ...capabilities.tasks,
      taskStore,
      taskMessageQueue: new InMemoryTaskMessageQueue(),
    };
  }

  const orchestrator = taskStore ? new TaskOrchestrator(taskStore) : undefined;

  const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> = {
    capabilities: {
      logging: capabilities.logging,
      resources: capabilities.resources,
      tools: capabilities.tools,
      prompts: capabilities.prompts,
      completions: capabilities.completions,
      extensions: capabilities.extensions,
      ...(capabilities.tasks ? { tasks: capabilities.tasks } : {}),
    },
    enforceStrictCapabilities: true,
  };

  serverConfig.instructions =
    'filesystem-mcp: Secure local filesystem MCP server. ' +
    'Start with: roots -> ls/find -> stat -> read. Never guess paths. ' +
    'For full guidance, read internal://instructions or run the get-help prompt.';

  const implementation: Implementation = {
    name: 'filesystem-mcp',
    title: 'Filesystem MCP',
    version: SERVER_VERSION,
    ...(SERVER_DESCRIPTION ? { description: SERVER_DESCRIPTION } : {}),
    ...(SERVER_HOMEPAGE ? { websiteUrl: SERVER_HOMEPAGE } : {}),
  };
  const server = new McpServer(withDefaultIcons(implementation, localIcon), serverConfig);

  const loggingState = createLoggingState(LOG_LEVEL);
  const rootsManager = new RootsManager(options, loggingState);

  await rootsManager.recomputeAllowedDirectories();

  server.server.setRequestHandler('logging/setLevel', (req: { params: SetLevelRequestParams }) => {
    loggingState.minimumLevel = req.params.level;
    Logger.notice(`Log level set to ${req.params.level}`);
    return {};
  });

  // Track stdio server by default; HTTP overrides per-session via the registry.
  logRouter.attachStdio({ server, loggingState });

  const resourcesHandle = registerAllResources(server, {
    resourceStore,
    pathGuard: rootsManager.pathGuard,
    ...(localIcon ? { iconInfo: localIcon } : {}),
  });

  registerAllPrompts(server, {
    pathGuard: rootsManager.pathGuard,
    instructions: serverInstructionsContent,
    isInitialized: options.isInitialized ?? (() => rootsManager.isInitialized()),
    ...(localIcon ? { iconInfo: localIcon } : {}),
  });
  registerAllTools(server, {
    pathGuard: rootsManager.pathGuard,
    resourceStore,
    isInitialized: options.isInitialized ?? (() => rootsManager.isInitialized()),
    orchestrator,
  });

  return new FilesystemServerContext(server, rootsManager, resourceStore, resourcesHandle);
}
