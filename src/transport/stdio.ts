// stdio hosting: the pinned-instance factory, legacy roots seeding, and the
// gated transport that attaches listen-filter watchers before the SDK sees the
// message.
import type { McpServerFactory } from '@modelcontextprotocol/server';
import { JSONRPC_VERSION, ProtocolErrorCode } from '@modelcontextprotocol/server';
import {
  serveStdio,
  type StdioServerHandle,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';

import { fileURLToPath } from 'node:url';

import { formatUnknownErrorMessage } from '../core/errors.js';
import { Logger } from '../core/observability.js';
import type { ServerOptions } from '../core/path.js';
import { createWatcherRegistry } from '../core/watcher-registry.js';
import type { FilesystemServerContext } from '../server.js';
import { createServer } from '../server.js';
import type { RuntimeConfig } from './shared.js';
import { jsonRpcRequestId, listenSubscriptionUris, prepareListenWatchers } from './shared.js';

/**
 * Seed the guard's allowed roots from the client's declared workspace roots.
 * Legacy-era only: push-style `roots/list` is deprecated (SEP-2577) and throws
 * on a 2026-07-28 connection, where clients pass paths as tool arguments and
 * the access-grant round-trip covers out-of-root paths instead. Every root
 * still passes `applyGrant`'s boundary and unsafe-path guards, so a client
 * cannot root-declare its way into $HOME or past ROOT_BOUNDARY — a refused
 * root is skipped and its paths fail closed at validateAccess like any other.
 */
export async function seedRootsFromClient(ctx: FilesystemServerContext): Promise<number> {
  let roots: readonly { uri: string }[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- legacy-era-only; the modern era never reaches the hooks that call this.
    ({ roots } = await ctx.mcp.server.listRoots());
  } catch (err: unknown) {
    // Client without the roots capability (strict-capabilities throw), or the
    // request failed — either way there is nothing to seed.
    Logger.debug('[Stdio] roots/list unavailable', { error: formatUnknownErrorMessage(err) });
    return 0;
  }
  let granted = 0;
  for (const root of roots) {
    let dir: string;
    try {
      dir = fileURLToPath(root.uri);
    } catch {
      continue; // not a file:// root
    }
    try {
      if (await ctx.pathGuard.applyGrant(dir)) granted += 1;
      else Logger.debug('[Stdio] client root refused by grant policy', { dir });
    } catch (err: unknown) {
      Logger.debug('[Stdio] client root grant failed', {
        dir,
        error: formatUnknownErrorMessage(err),
      });
    }
  }
  // No list-changed notification follows a grant. Allowed roots were once listed
  // as concrete resources, and are not any more: the file template's `list()`
  // returns nothing and the other two lists never read the roots at all (see
  // resources.ts). Notifying bought the client a re-fetch of an unchanged list.
  if (granted > 0) {
    Logger.info(`[Stdio] allowed ${granted} client-declared workspace root(s)`);
  }
  return granted;
}

/**
 * Serve filesystem-mcp over stdio using modern protocol revision 2026-07-28.
 *
 * The SDK's `StdioListenRouter` acknowledges `subscriptions/listen` and routes
 * the pinned instance's outbound change notifications onto the matching
 * streams, but it exposes no listen-filter hook, so nothing attaches the
 * filesystem watcher that would produce those notifications. `serveStdio`'s
 * `transport` option is the seam: it installs its own `onmessage` synchronously
 * and only then starts the wire, so wrapping that callback afterwards gives the
 * same view of the inbound `resourceSubscriptions` filter the HTTP leg reads off
 * `req.body`. The watcher's notify sink calls `sendResourceUpdated` on the
 * pinned instance, which the router then delivers to the listening stream.
 *
 * ponytail: stdio watchers live for the connection and are freed by
 * `registry.destroy()` at close, not when one listen stream ends — the router
 * exposes no per-stream close hook the way an HTTP SSE response does. Bounded by
 * MAX_WATCHERS, and a stdio connection has exactly one client.
 */
export function startServer(options: ServerOptions, config: RuntimeConfig = {}): StdioServerHandle {
  let activeCtx: FilesystemServerContext | undefined;
  // Shared with the resource contract so a `resources/subscribe` and a
  // `subscriptions/listen` naming the same URI reuse one watcher.
  const registry = createWatcherRegistry();
  const factory: McpServerFactory = async ({ era }) => {
    const c = await createServer(options, {
      watcherRegistry: registry,
      era,
      ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    });
    activeCtx = c;
    if (era === 'legacy') {
      // Fires when the client's `notifications/initialized` lands. Safe to own:
      // the SDK's only touchpoint is its own initialized handler reading it.
      c.mcp.server.oninitialized = () => {
        void seedRootsFromClient(c);
      };
      // Re-list and grant anything new. Grants are session-additive (R8): a
      // root the client withdrew is not revoked mid-session.
      c.mcp.server.setNotificationHandler('notifications/roots/list_changed', () => {
        void seedRootsFromClient(c);
      });
    }
    return c.mcp;
  };

  // One sink for the whole connection. `addCallback` de-duplicates by function
  // identity, so re-using this closure makes a repeat `subscriptions/listen` on
  // an already-watched URI a no-op; a fresh closure per listen would instead
  // stack a callback every time, double-notifying and growing an
  // `activeCallbacks` set that MAX_WATCHERS does not bound (it caps watchers,
  // not callbacks). Reads `activeCtx` when it fires rather than capturing it, so
  // it never pins a disposed instance.
  const sink = (uri: string): void => {
    // A failed notify means the connection went away; nothing to recover.
    void activeCtx?.mcp.server.sendResourceUpdated({ uri }).catch((err: unknown) => {
      Logger.debug('[Stdio] resource update not delivered', {
        uri,
        error: formatUnknownErrorMessage(err),
      });
    });
  };

  const wire = new StdioServerTransport();
  const handle = serveStdio(factory, {
    legacy: 'serve',
    transport: wire,
    onerror: (error: unknown) => {
      Logger.error('[Stdio] serve error:', formatUnknownErrorMessage(error));
    },
  });

  // Wrap the callback `serveStdio` just installed. A message with no listen
  // filter is forwarded on the spot, so one slow attach cannot stall the
  // connection's other traffic (a `notifications/cancelled` for the very request
  // being gated, most of all); gated messages stay ordered among themselves, so
  // two listens naming the same URI cannot race the registry's ref-count.
  //
  // Every lease taken here is held for the rest of the connection: stdio has no
  // per-stream close hook, so nothing releases them and `registry.destroy` at
  // close is the only teardown. That covers a listen the SDK goes on to reject
  // too — the watcher stays until the connection ends, bounded by MAX_WATCHERS.
  // Per-subscription release needs the id the unsubscribe contract does not
  // carry (see watcher-registry.ts).
  //
  // serveStdio installs its onmessage synchronously and only then starts the
  // wire; this wrapper is only correct because of that ordering. Assert it
  // rather than degrade to a silent no-op if a future SDK release changes it.
  const deliver = wire.onmessage;
  if (!deliver) {
    throw new Error(
      'serveStdio did not install a synchronous onmessage handler; the subscriptions/listen watcher gate cannot attach. This is an SDK contract change, not a configuration error.',
    );
  }
  let gated = Promise.resolve();
  wire.onmessage = (message) => {
    if (listenSubscriptionUris(message).length === 0) {
      deliver(message);
      return;
    }
    gated = gated
      .then(async () => {
        const id = jsonRpcRequestId(message);
        const ctx = activeCtx;
        if (id !== null && ctx) {
          const prepared = await prepareListenWatchers(message, ctx.pathGuard, registry, sink);
          if (!prepared.ok) {
            await wire.send({
              jsonrpc: JSONRPC_VERSION,
              id,
              error: { code: ProtocolErrorCode.InvalidParams, message: prepared.message },
            });
            return;
          }
        }
        deliver(message);
      })
      .catch(async (error: unknown) => {
        const failure =
          error instanceof Error ? error : new Error(formatUnknownErrorMessage(error));
        wire.onerror?.(failure);
        // The gate swallowed the message, so nothing downstream will answer it.
        // Without this the client waits out its whole request timeout.
        const id = jsonRpcRequestId(message);
        if (id === null) return;
        await wire
          .send({
            jsonrpc: JSONRPC_VERSION,
            id,
            error: { code: ProtocolErrorCode.InternalError, message: failure.message },
          })
          .catch(() => {
            /* the wire is gone; onerror above already reported it */
          });
      });
  };

  return {
    close: async () => {
      registry.destroy();
      try {
        activeCtx?.disposeRuntimeState();
      } catch {
        /* idempotent — disposeRuntimeState guards cleanedUp */
      }
      activeCtx = undefined;
      await handle.close();
    },
  };
}
