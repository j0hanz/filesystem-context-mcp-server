import type { Implementation, ServerCapabilities } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';

import { readFile } from 'node:fs/promises';

import { GuardedFileSystem } from './core/fs.js';
import type { ServerOptions } from './core/path.js';
import { PathGuard } from './core/path.js';
import type { IconInfo } from './core/primitives.js';
import { withDefaultIcons } from './core/primitives.js';
import type { Registrar, ServerDeps } from './core/registrar.js';
import { ResourceStore } from './core/store.js';
import type { WatcherRegistry } from './core/watcher-registry.js';
import { pkgInfo } from './pkg-info.js';
import { promptsRegistrar } from './prompts.js';
import { INSTRUCTIONS_URI, resourcesRegistrar } from './resources.js';
import { toolsRegistrar } from './tools/index.js';
import { requestStateCodec } from './tools/input-required.js';

// ═══════════════════════════════════════════════════════════════
// bootstrap
// ═══════════════════════════════════════════════════════════════

const {
  version: SERVER_VERSION,
  description: SERVER_DESCRIPTION,
  homepage: SERVER_HOMEPAGE,
} = pkgInfo;

export class FilesystemServerContext {
  public readonly mcp: McpServer;
  public readonly pathGuard: PathGuard;
  public readonly fs: GuardedFileSystem;
  public readonly resources: ResourceStore;
  private readonly registrars: readonly Registrar[];
  private cleanedUp = false;

  constructor(
    mcp: McpServer,
    pathGuard: PathGuard,
    resources: ResourceStore,
    registrars: readonly Registrar[],
  ) {
    this.mcp = mcp;
    this.pathGuard = pathGuard;
    this.fs = new GuardedFileSystem(pathGuard);
    this.resources = resources;
    this.registrars = registrars;
  }

  disposeRuntimeState(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    for (const r of this.registrars) r.dispose(this.mcp);
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
    /** Modern-leg resource-updated notify sink (publishes to the ServerEventBus). */
    notifyResourceUpdated?: (uri: string) => void;
  },
): Promise<FilesystemServerContext> {
  const resourceStore = new ResourceStore();
  const localIcon = await getLocalIconInfo();

  // No `logging` capability: SEP-2577 deprecates the subsystem, and this server
  // routes every diagnostic to stderr rather than notifications/message.
  const capabilities = {
    resources: { subscribe: true },
    tools: {},
    prompts: {},
    completions: {},
  } satisfies ServerCapabilities;

  const cacheScope = process.env['API_KEY'] ? 'private' : 'public';
  const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> = {
    capabilities,
    enforceStrictCapabilities: true,
    cacheHints: {
      'tools/list': { ttlMs: 60_000, cacheScope },
      'prompts/list': { ttlMs: 60_000, cacheScope },
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

  const pathGuard = new PathGuard(options, true);
  await pathGuard.recomputeAllowedDirectories();

  const deps: ServerDeps = {
    server,
    pathGuard,
    resourceStore,
    ...(localIcon ? { iconInfo: localIcon } : {}),
    ...(options.readOnly ? { readOnly: true } : {}),
    ...(extraDeps?.watcherRegistry ? { watcherRegistry: extraDeps.watcherRegistry } : {}),
    ...(extraDeps?.notifyResourceUpdated
      ? { notifyResourceUpdated: extraDeps.notifyResourceUpdated }
      : {}),
  };

  const registrars: Registrar[] = [resourcesRegistrar, promptsRegistrar, toolsRegistrar];
  for (const r of registrars) r.register(deps);

  return new FilesystemServerContext(server, pathGuard, resourceStore, registrars);
}
