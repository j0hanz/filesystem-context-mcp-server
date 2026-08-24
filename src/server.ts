import type { Implementation, ServerCapabilities } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';

import { readFile } from 'node:fs/promises';

import packageJson from '../package.json' with { type: 'json' };
import { GuardedFileSystem } from './core/fs.js';
import { requestStateCodec } from './core/input-required.js';
import { Logger } from './core/observability.js';
import type { ServerOptions } from './core/path.js';
import { PathGuard } from './core/path.js';
import type { IconInfo } from './core/primitives.js';
import { withDefaultIcons } from './core/primitives.js';
import { ResourceStore } from './core/store.js';
import type { WatcherRegistry } from './core/watcher-registry.js';
import { INSTRUCTIONS_URI } from './instructions.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools/index.js';

export interface ServerNotifier {
  readonly toolsChanged?: () => void;
  readonly promptsChanged?: () => void;
  readonly resourcesChanged?: () => void;
  readonly resourceUpdated: (uri: string) => void;
}

export interface ServerDeps {
  readonly server: McpServer;
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore;
  readonly iconInfo?: IconInfo;
  readonly readOnly?: boolean;
  /** Shared file-watcher registry for the modern HTTP leg; omitted on stdio. */
  readonly watcherRegistry?: WatcherRegistry;
  /** Modern-leg typed notification publisher. */
  readonly notifier?: ServerNotifier;
}

// ═══════════════════════════════════════════════════════════════
// bootstrap
// ═══════════════════════════════════════════════════════════════

const {
  version: SERVER_VERSION,
  description: SERVER_DESCRIPTION,
  homepage: SERVER_HOMEPAGE,
} = packageJson;

export class FilesystemServerContext {
  public readonly mcp: McpServer;
  public readonly pathGuard: PathGuard;
  public readonly fs: GuardedFileSystem;
  public readonly resources: ResourceStore;
  private readonly resourceDisposable?: { dispose(): void } | undefined;
  private cleanedUp = false;

  constructor(
    mcp: McpServer,
    pathGuard: PathGuard,
    resources: ResourceStore,
    resourceDisposable?: { dispose(): void },
  ) {
    this.mcp = mcp;
    this.pathGuard = pathGuard;
    this.fs = new GuardedFileSystem(pathGuard);
    this.resources = resources;
    this.resourceDisposable = resourceDisposable;
  }

  disposeRuntimeState(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.resourceDisposable?.dispose();
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
    try {
      const iconPath = new URL(`../assets/${name}`, import.meta.url);
      const buffer = await readFile(iconPath);
      return {
        src: `data:${mime};base64,${buffer.toString('base64')}`,
        mimeType: mime,
      };
    } catch {
      return undefined;
    }
  })();

  return cachedIconInfo;
}

export async function createServer(
  options: ServerOptions = {},
  extraDeps?: {
    /** Shared file-watcher registry for the modern (per-request) HTTP leg. */
    watcherRegistry?: WatcherRegistry;
    /** Modern-leg typed notification publisher. */
    notifier?: ServerNotifier;
  },
): Promise<FilesystemServerContext> {
  const resourceStore = new ResourceStore();
  const localIcon = await getLocalIconInfo();

  const capabilities = {
    resources: { subscribe: true, listChanged: true },
    tools: {},
    prompts: {},
    completions: {},
    logging: {},
  } satisfies ServerCapabilities;

  const cacheScope = process.env['API_KEY'] ? 'private' : 'public';
  const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> = {
    capabilities,
    enforceStrictCapabilities: true,
    cacheHints: {
      'tools/list': { ttlMs: 60_000, cacheScope },
      'prompts/list': { ttlMs: 60_000, cacheScope },
      'resources/list': { ttlMs: 30_000, cacheScope },
      'resources/templates/list': { ttlMs: 60_000, cacheScope },
      'server/discover': { ttlMs: 60_000, cacheScope },
    },
    // Multi-round-trip `requestState` integrity (protocol revision 2026-07-28):
    // the codec verifies the HMAC on every retried round before the handler
    // runs, so a tampered or expired state is rejected as `-32602` rather than
    // trusted. The decoded `PendingState` reaches handlers via
    // `ctx.mcpReq.requestState<T>()`.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    requestState: { verify: requestStateCodec.verify },
  };

  serverConfig.instructions =
    'filesystem-mcp: Secure local filesystem MCP server. ' +
    'Start with: list_roots -> list/find_files -> stat -> read. Never guess paths. ' +
    `For full guidance, read ${INSTRUCTIONS_URI} or run the get-help prompt.`;

  const implementation: Implementation = {
    name: 'filesystem-mcp',
    title: 'Filesystem MCP',
    version: SERVER_VERSION,
    ...(SERVER_DESCRIPTION ? { description: SERVER_DESCRIPTION } : {}),
    ...(SERVER_HOMEPAGE ? { websiteUrl: SERVER_HOMEPAGE } : {}),
  };
  const server = new McpServer(withDefaultIcons(implementation, localIcon), serverConfig);
  server.server.fallbackNotificationHandler = (notification) => {
    Logger.debug('Unhandled client notification', { method: notification.method });
    return Promise.resolve();
  };

  const pathGuard = new PathGuard(options, true);
  await pathGuard.recomputeAllowedDirectories();

  const deps: ServerDeps = {
    server,
    pathGuard,
    resourceStore,
    ...(localIcon ? { iconInfo: localIcon } : {}),
    ...(options.readOnly ? { readOnly: true } : {}),
    ...(extraDeps?.watcherRegistry ? { watcherRegistry: extraDeps.watcherRegistry } : {}),
    ...(extraDeps?.notifier ? { notifier: extraDeps.notifier } : {}),
  };

  const resourceDisposable = registerResources(deps);
  registerPrompts(deps);
  registerTools(deps);

  return new FilesystemServerContext(server, pathGuard, resourceStore, resourceDisposable);
}
