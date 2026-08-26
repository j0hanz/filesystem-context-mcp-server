import type {
  Implementation,
  ServerCapabilities,
  ServerNotifier,
} from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';

import packageJson from '../package.json' with { type: 'json' };
import { GuardedFileSystem } from './core/fs.js';
import { requestStateCodec } from './core/input-required.js';
import { Logger } from './core/observability.js';
import type { ServerOptions } from './core/path.js';
import { PathGuard } from './core/path.js';
import { ResourceStore } from './core/store.js';
import type { WatcherRegistry } from './core/watcher-registry.js';
import { INSTRUCTIONS_URI } from './instructions.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools/index.js';

export type { ServerNotifier };
export type { ServerOptions };

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

export async function createServer(
  options: ServerOptions = {},
  extraDeps?: {
    /** Shared file-watcher registry for the modern (per-request) HTTP leg. */
    watcherRegistry?: WatcherRegistry;
    /** Modern-leg typed notification publisher. */
    notifier?: ServerNotifier;
    /**
     * Guard to use instead of constructing one. The HTTP leg builds a single
     * guard for the whole endpoint and passes it to every per-request instance,
     * so an accepted access grant survives the request that accepted it (R8) and
     * the listen-watcher path validates against the same allowed set. Omitted on
     * stdio, where the instance is pinned for the connection and owns its guard.
     */
    pathGuard?: PathGuard;
    /**
     * Store to use instead of constructing one. The HTTP modern leg shares one
     * store across every per-request instance, so a result a tool externalized
     * in one POST survives to the follow-up resources/read. Omitted on stdio,
     * where the pinned instance owns its store for the connection.
     */
    resourceStore?: ResourceStore;
    /** The protocol era this instance serves; omitted where the caller does not know. */
    era?: 'legacy' | 'modern';
    /**
     * The resolved HTTP credential, from `--api-key` or `API_KEY`. Lives here
     * rather than on `ServerOptions` because that object is `PathGuard`'s
     * constructor argument and is exposed on its public `options` field — a
     * bearer secret has no business being reachable from a tool handler.
     */
    apiKey?: string;
  },
): Promise<FilesystemServerContext> {
  // `resources.subscribe` stays advertised on both eras: the verb itself is
  // 2025-only, but with enforceStrictCapabilities the SDK also gates outbound
  // `notifications/resources/updated` — which the modern `subscriptions/listen`
  // stream delivers — on this same capability bit.
  const capabilities = {
    resources: { subscribe: true, listChanged: true },
    tools: {},
    prompts: {},
    completions: {},
  } satisfies ServerCapabilities;

  const cacheScope = extraDeps?.apiKey ? 'private' : 'public';
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
  const server = new McpServer(implementation, serverConfig);
  server.server.fallbackNotificationHandler = (notification) => {
    Logger.debug('Unhandled client notification', { method: notification.method });
    return Promise.resolve();
  };

  // A failed send means the connection went away; nothing to recover.
  const resourceStore =
    extraDeps?.resourceStore ??
    new ResourceStore(() => {
      if (extraDeps?.notifier) {
        extraDeps.notifier.resourcesChanged();
        return;
      }
      void server.server.sendResourceListChanged().catch((error: unknown) => {
        Logger.debug('resource list_changed not delivered', { error: String(error) });
      });
    });

  const pathGuard = extraDeps?.pathGuard ?? new PathGuard(options, true);
  // Recompute once per guard, keyed on the guard's own state rather than on
  // whether it was injected — an injected-but-uninitialized guard would
  // otherwise deny every path. Not unconditional: the HTTP leg shares one guard
  // across a fresh instance per request, and a repeat recompute would both redo
  // the root resolution per request and race a concurrent `applyGrant`, which
  // commits under a mutation lock this call does not take.
  if (!pathGuard.isInitialized()) await pathGuard.recomputeAllowedDirectories();

  const deps = {
    server,
    pathGuard,
    resourceStore,
    ...(options.readOnly ? { readOnly: true } : {}),
    ...(extraDeps?.watcherRegistry ? { watcherRegistry: extraDeps.watcherRegistry } : {}),
    ...(extraDeps?.notifier ? { notifier: extraDeps.notifier } : {}),
    ...(extraDeps?.era ? { era: extraDeps.era } : {}),
  };

  const resourceDisposable = registerResources(deps);
  registerPrompts(deps);
  registerTools(deps);

  return new FilesystemServerContext(server, pathGuard, resourceStore, resourceDisposable);
}
