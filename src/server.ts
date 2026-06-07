import {
  type Implementation,
  InMemoryTaskMessageQueue,
  McpServer,
  type ServerCapabilities,
  type SetLevelRequestParams,
} from '@modelcontextprotocol/server';

import { readFile } from 'node:fs/promises';

import { GuardedFileSystem } from './core/fs.js';
import { createLoggingState, Logger, LogRouter } from './core/observability.js';
import { PathGuard, type ServerOptions } from './core/path.js';
import {
  McpLogSender,
  McpRootsSynchronizer,
  type Registrar,
  type ServerDeps,
} from './core/registrar.js';
import { createInMemoryResourceStore, type ResourceStore } from './core/store.js';
import { LOG_LEVEL } from './core/util.js';
import { pkgInfo } from './pkg-info.js';
import { promptsRegistrar } from './prompts.js';
import { resourcesRegistrar } from './resources.js';
import { TaskOrchestrator } from './tasks.js';
import { type IconInfo, withDefaultIcons } from './tools/define.js';
import { toolsRegistrar } from './tools/index.js';

// ═══════════════════════════════════════════════════════════════
// bootstrap
// ═══════════════════════════════════════════════════════════════

export const logRouter = LogRouter.global();

const {
  version: SERVER_VERSION,
  description: SERVER_DESCRIPTION,
  homepage: SERVER_HOMEPAGE,
} = pkgInfo;

export class FilesystemServerContext {
  public readonly mcp: McpServer;
  public readonly pathGuard: PathGuard;
  public readonly synchronizer: McpRootsSynchronizer;
  public readonly fs: GuardedFileSystem;
  public readonly resources: ResourceStore;
  public readonly resourcesHandle: { destroy(): void };
  private readonly orchestrator: TaskOrchestrator;
  private readonly registrars: readonly Registrar[];
  private cleanedUp = false;

  constructor(
    mcp: McpServer,
    pathGuard: PathGuard,
    synchronizer: McpRootsSynchronizer,
    resources: ResourceStore,
    resourcesHandle: { destroy(): void },
    orchestrator: TaskOrchestrator,
    registrars: readonly Registrar[],
  ) {
    this.mcp = mcp;
    this.pathGuard = pathGuard;
    this.synchronizer = synchronizer;
    this.fs = new GuardedFileSystem(pathGuard);
    this.resources = resources;
    this.resourcesHandle = resourcesHandle;
    this.orchestrator = orchestrator;
    this.registrars = registrars;
  }

  disposeRuntimeState(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.synchronizer.destroy();
    this.orchestrator.dispose();
    this.orchestrator.cleanup();
    for (const r of this.registrars) r.dispose();
    logRouter.detachStdio();
  }

  async close(): Promise<void> {
    this.disposeRuntimeState();
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

  const taskOrchestrator = new TaskOrchestrator();

  const capabilities = {
    logging: {},
    resources: { subscribe: true },
    tools: {},
    prompts: {},
    completions: {},
    extensions: {},
    tasks: {
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
      taskStore: taskOrchestrator,
      taskMessageQueue: new InMemoryTaskMessageQueue(),
    },
  } satisfies Omit<ServerCapabilities, 'tasks'> & { tasks: unknown };
  const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> = {
    capabilities,
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
  const pathGuard = new PathGuard(options, loggingState);
  await pathGuard.recomputeAllowedDirectories();
  const synchronizer = new McpRootsSynchronizer(pathGuard, loggingState);

  server.server.setRequestHandler('logging/setLevel', (req: { params: SetLevelRequestParams }) => {
    loggingState.minimumLevel = req.params.level;
    Logger.notice(`Log level set to ${req.params.level}`);
    return {};
  });

  // Track stdio server by default; HTTP overrides per-session via the registry.
  logRouter.attachStdio({ sender: new McpLogSender(server), loggingState });

  const isInitialized = options.isInitialized ?? (() => synchronizer.isInitialized());
  const deps: ServerDeps = {
    server,
    pathGuard,
    resourceStore,
    orchestrator: taskOrchestrator,
    isInitialized,
    ...(localIcon ? { iconInfo: localIcon } : {}),
  };

  const registrars: Registrar[] = [resourcesRegistrar, promptsRegistrar, toolsRegistrar];
  for (const r of registrars) r.register(deps);

  const resourcesHandle = {
    destroy: () => {
      resourcesRegistrar.dispose();
    },
  };

  return new FilesystemServerContext(
    server,
    pathGuard,
    synchronizer,
    resourceStore,
    resourcesHandle,
    taskOrchestrator,
    registrars,
  );
}
