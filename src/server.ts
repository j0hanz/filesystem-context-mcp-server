import {
  type Implementation,
  InMemoryTaskMessageQueue,
  McpServer,
  type ServerCapabilities,
  type SetLevelRequestParams,
} from '@modelcontextprotocol/server';

import { readFile } from 'node:fs/promises';

import { createLoggingState, Logger, LogRouter } from './core/observability.js';
import { PathGuard, type ServerOptions } from './core/path.js';
import { createInMemoryResourceStore, type ResourceStore } from './core/store.js';
import { LOG_LEVEL, SENSITIVE_FILE_DENYLIST } from './core/util.js';
import { pkgInfo } from './pkg-info.js';
import { registerAllPrompts } from './prompts.js';
import {
  registerAllResources,
  type ResourcesHandle,
  serverInstructionsContent,
} from './resources.js';
import { TaskOrchestrator } from './tasks.js';
import { registerAllTools } from './tools.js';
import { type IconInfo, withDefaultIcons } from './tools/_helpers.js';

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
  public readonly pathGuard: PathGuard;
  public readonly resources: ResourceStore;
  public readonly resourcesHandle: ResourcesHandle;
  private readonly orchestrator: TaskOrchestrator;
  private cleanedUp = false;

  constructor(
    mcp: McpServer,
    pathGuard: PathGuard,
    resources: ResourceStore,
    resourcesHandle: ResourcesHandle,
    orchestrator: TaskOrchestrator,
  ) {
    this.mcp = mcp;
    this.pathGuard = pathGuard;
    this.resources = resources;
    this.resourcesHandle = resourcesHandle;
    this.orchestrator = orchestrator;
  }

  disposeRuntimeState(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.orchestrator.dispose();
    this.orchestrator.cleanup();
    this.resourcesHandle.destroy();
    this.pathGuard.destroy();
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
  const capabilities = buildServerCapabilities({
    enablePromptListChanged: false,
    enableTaskToolRequests: true,
  });

  const taskOrchestrator = new TaskOrchestrator();

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

  if (serverConfig.capabilities?.tasks) {
    Object.assign(serverConfig.capabilities.tasks, {
      taskStore: taskOrchestrator,
      taskMessageQueue: new InMemoryTaskMessageQueue(),
    });
  }

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
  const pathGuard = new PathGuard(SENSITIVE_FILE_DENYLIST, options, loggingState);

  await pathGuard.recomputeAllowedDirectories();

  server.server.setRequestHandler('logging/setLevel', (req: { params: SetLevelRequestParams }) => {
    loggingState.minimumLevel = req.params.level;
    Logger.notice(`Log level set to ${req.params.level}`);
    return {};
  });

  // Track stdio server by default; HTTP overrides per-session via the registry.
  logRouter.attachStdio({ server, loggingState });

  const resourcesHandle = registerAllResources(server, {
    resourceStore,
    pathGuard,
    ...(localIcon ? { iconInfo: localIcon } : {}),
  });

  registerAllPrompts(server, {
    pathGuard,
    instructions: serverInstructionsContent,
    isInitialized: options.isInitialized ?? (() => pathGuard.isInitialized()),
    ...(localIcon ? { iconInfo: localIcon } : {}),
  });
  registerAllTools(server, {
    pathGuard,
    resourceStore,
    isInitialized: options.isInitialized ?? (() => pathGuard.isInitialized()),
    orchestrator: taskOrchestrator,
  });

  return new FilesystemServerContext(
    server,
    pathGuard,
    resourceStore,
    resourcesHandle,
    taskOrchestrator,
  );
}
