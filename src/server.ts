import {
  checkResourceAllowed,
  type Implementation,
  InMemoryTaskMessageQueue,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
  resourceUrlFromServerUrl,
  type SetLevelRequestParams,
  UriTemplate,
} from '@modelcontextprotocol/server';

import { readFile } from 'node:fs/promises';

import { createLoggingState, Logger, LogRouter, withTelemetry } from './core/observability.js';
import { PathGuard, type ServerOptions } from './core/path.js';
import { createInMemoryResourceStore, type ResourceStore } from './core/store.js';
import { LOG_LEVEL } from './core/util.js';
import { pkgInfo } from './pkg-info.js';
import { PROMPT_ENTRIES } from './prompts.js';
import {
  getResourceContracts,
  type ResourcesHandle,
  serverInstructionsContent,
} from './resources.js';
import { TaskOrchestrator } from './tasks.js';
import { CALCULATE_HASH } from './tools/calculate-hash.js';
import { CREATE } from './tools/create.js';
import { type IconInfo, withDefaultIcons } from './tools/define.js';
import { DELETE_FILE } from './tools/delete-file.js';
import { EDIT } from './tools/edit.js';
import { LIST } from './tools/list.js';
import { MOVE } from './tools/move.js';
import { READ_FILE } from './tools/read.js';
import { SEARCH_AND_REPLACE } from './tools/replace-in-files.js';
import { LIST_ALLOWED_DIRECTORIES } from './tools/roots.js';
import { SEARCH_CONTENT } from './tools/search-content.js';
import { SEARCH_FILES } from './tools/search-files.js';
import { GET_FILE_INFO } from './tools/stat.js';

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

  const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> = {
    capabilities: {
      logging: {},
      resources: { subscribe: true, listChanged: true },
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
  const pathGuard = new PathGuard(options, loggingState);
  await pathGuard.recomputeAllowedDirectories();

  server.server.setRequestHandler('logging/setLevel', (req: { params: SetLevelRequestParams }) => {
    loggingState.minimumLevel = req.params.level;
    Logger.notice(`Log level set to ${req.params.level}`);
    return {};
  });

  // Track stdio server by default; HTTP overrides per-session via the registry.
  logRouter.attachStdio({ server, loggingState });

  const resourcesOptions = {
    resourceStore,
    pathGuard,
    ...(localIcon ? { iconInfo: localIcon } : {}),
  };
  const resourceContracts = getResourceContracts(resourcesOptions);

  for (const contract of resourceContracts) {
    const config = withDefaultIcons(
      {
        title: contract.title,
        description: contract.description,
        mimeType: contract.mimeType,
        annotations: contract.annotations,
      },
      resourcesOptions.iconInfo,
    );

    if (contract.uriTemplate) {
      const template = new ResourceTemplate(contract.uriTemplate, {
        list: undefined,
        ...(contract.complete
          ? {
              complete: Object.fromEntries(
                new UriTemplate(contract.uriTemplate).variableNames.map((varName) => [
                  varName,
                  (value: string, ctx?: { arguments?: Record<string, string> }) => {
                    const completeFn = contract.complete;
                    return completeFn ? completeFn(varName, value, ctx) : [];
                  },
                ]),
              ),
            }
          : {}),
      });

      server.registerResource(contract.name, template, config, (uri, variables, ctx) =>
        contract.read(uri, variables, ctx),
      );
    } else if (contract.uri) {
      server.registerResource(contract.name, contract.uri, config, (uri, ctx) =>
        contract.read(uri, {}, ctx),
      );
    }
  }

  server.server.setRequestHandler(
    'resources/subscribe',
    (req: { params: { uri: string } }, ctx) => {
      const requestedResource = resourceUrlFromServerUrl(req.params.uri);
      return withTelemetry(
        {
          event: 'resource_subscription',
          action: 'subscribe',
          uri: requestedResource.toString(),
          session_id: ctx.sessionId ?? null,
        },
        () => {
          let foundMatch = false;
          for (const contract of resourceContracts) {
            if (!contract.subscribe) continue;
            const configured = contract.uri ?? contract.uriTemplate.split('{')[0];
            if (!configured) continue;
            if (
              checkResourceAllowed({
                requestedResource,
                configuredResource: configured,
              })
            ) {
              foundMatch = true;
              contract.subscribe(requestedResource.toString(), (updatedUri) => {
                void server.server.sendResourceUpdated({ uri: updatedUri }).catch(() => {
                  /* Transport may be closed */
                });
              });
              break;
            }
          }
          if (!foundMatch) {
            throw new ProtocolError(
              ProtocolErrorCode.ResourceNotFound,
              `Resource not found: ${requestedResource.toString()}`,
            );
          }
          return {};
        },
      );
    },
  );

  server.server.setRequestHandler(
    'resources/unsubscribe',
    (req: { params: { uri: string } }, ctx) => {
      const canonical = resourceUrlFromServerUrl(req.params.uri).toString();
      return withTelemetry(
        {
          event: 'resource_subscription',
          action: 'unsubscribe',
          uri: canonical,
          session_id: ctx.sessionId ?? null,
        },
        () => {
          for (const contract of resourceContracts) {
            if (contract.unsubscribe) {
              contract.unsubscribe(canonical);
            }
          }
          return {};
        },
      );
    },
  );

  const resourcesHandle = {
    destroy(): void {
      for (const contract of resourceContracts) {
        if (contract.destroy) {
          contract.destroy();
        }
      }
    },
  };

  const promptsOptions = {
    pathGuard,
    instructions: serverInstructionsContent,
    isInitialized: options.isInitialized ?? (() => pathGuard.isInitialized()),
    ...(localIcon ? { iconInfo: localIcon } : {}),
  };
  for (const { register } of PROMPT_ENTRIES) {
    register(server, promptsOptions);
  }

  const toolDeps = {
    server,
    isInitialized: options.isInitialized ?? (() => pathGuard.isInitialized()),
    pathGuard,
    resourceStore,
    orchestrator: taskOrchestrator,
  };
  const ALL_TOOLS = [
    CALCULATE_HASH,
    CREATE,
    DELETE_FILE,
    EDIT,
    LIST,
    MOVE,
    READ_FILE,
    SEARCH_AND_REPLACE,
    LIST_ALLOWED_DIRECTORIES,
    SEARCH_CONTENT,
    SEARCH_FILES,
    GET_FILE_INFO,
  ] as const;

  for (const tool of ALL_TOOLS) {
    tool.register(toolDeps);
  }

  return new FilesystemServerContext(
    server,
    pathGuard,

    resourceStore,
    resourcesHandle,
    taskOrchestrator,
  );
}
