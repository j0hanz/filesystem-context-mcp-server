import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type {
  JSONRPCMessage,
  McpHttpHandler,
  McpServerFactory,
} from '@modelcontextprotocol/server';
import {
  createMcpHandler,
  DEFAULT_REQUEST_TIMEOUT_MSEC,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
import {
  serveStdio,
  type StdioServerHandle,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';

import type { Server } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import type { Express, NextFunction, Request, Response } from 'express';

import { formatUnknownErrorMessage } from './core/errors.js';
import { assertFleetRequestStateKey } from './core/input-required.js';
import { Logger } from './core/observability.js';
import { PathGuard } from './core/path.js';
import type { ServerOptions } from './core/path.js';
import { ResourceStore } from './core/store.js';
import { MIB, parseEnvInt } from './core/util.js';
import {
  createWatcherRegistry,
  MAX_WATCHERS,
  type WatcherRegistry,
} from './core/watcher-registry.js';
import {
  assertHttpBindingPolicy,
  assertHttpHostPolicy,
  bearerAuthMiddleware,
  computeAllowedOriginHostnames,
  corsOriginMiddleware,
  corsPreflightHandler,
  createRateLimiter,
  protectedResourceUrl,
  resolveAllowedHosts,
  resolveTrustProxySetting,
  sendJsonRpcError,
} from './http-policy.js';
import { attachFileWatcherForUri } from './resources.js';
import type { FilesystemServerContext, ServerNotifier } from './server.js';
import { createServer } from './server.js';

// ═══════════════════════════════════════════════════════════════
// stdio
// ═══════════════════════════════════════════════════════════════

/**
 * Serve filesystem-mcp over stdio using modern protocol revision 2026-07-28.
 *
 * The SDK's `StdioListenRouter` acknowledges `subscriptions/listen` and routes
 * the pinned instance's outbound change notifications onto the matching
 * streams, but it exposes no listen-filter hook, so nothing attaches the
 * filesystem watcher that would produce those notifications. `serveStdio`'s
 * `transport` option is the seam: the entry installs its own `onmessage`
 * synchronously before starting the wire, so wrapping that callback afterwards
 * gives the same view of the inbound `resourceSubscriptions` filter the HTTP leg
 * reads off `req.body`. The watcher's notify sink calls `sendResourceUpdated` on
 * the pinned instance, which the router then delivers to the listening stream.
 *
 * ponytail: stdio watchers live for the connection and are freed by
 * `registry.destroy()` at close, not when one listen stream ends — the router
 * exposes no per-stream close hook the way an HTTP SSE response does. Bounded by
 * MAX_WATCHERS, and a stdio connection has exactly one client.
 */
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
  if (granted > 0) {
    Logger.info(`[Stdio] allowed ${granted} client-declared workspace root(s)`);
    // Allowed roots are listed as resources; tell the client the list grew.
    void ctx.mcp.server.sendResourceListChanged().catch((err: unknown) => {
      Logger.debug('[Stdio] resource list_changed not delivered', {
        error: formatUnknownErrorMessage(err),
      });
    });
  }
  return granted;
}

export function startServer(options: ServerOptions): StdioServerHandle {
  let activeCtx: FilesystemServerContext | undefined;
  // Shared with the resource contract so a `resources/subscribe` and a
  // `subscriptions/listen` naming the same URI reuse one watcher.
  const registry = createWatcherRegistry();
  const factory: McpServerFactory = async ({ era }) => {
    const c = await createServer(options, { watcherRegistry: registry, era });
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

  const wire = new StdioServerTransport();
  const handle = serveStdio(factory, {
    legacy: 'serve',
    transport: wire,
    onerror: (error: unknown) => {
      Logger.error('[Stdio] serve error:', formatUnknownErrorMessage(error));
    },
  });

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

  const attachForListen = (message: JSONRPCMessage): void => {
    const uris = listenSubscriptionUris(message);
    if (uris.length === 0) return;
    const ctx = activeCtx;
    if (!ctx) return;
    for (const uri of uris) {
      void attachFileWatcherForUri(registry, ctx.pathGuard, uri, sink).catch((err: unknown) => {
        Logger.warn(
          `[Stdio] listen watcher attach failed for ${uri}:`,
          formatUnknownErrorMessage(err),
        );
      });
    }
  };

  // Intercept through an accessor, not a one-shot reassignment: `serveStdio`
  // installs the SDK's own `onmessage` and may reinstall it later (reconnect,
  // legacy branch swap). A plain wrapper would be overwritten by that, silently
  // dropping the tap and leaving every listen subscription watcher-less with no
  // error. The setter re-wraps instead, so whatever the SDK assigns stays
  // downstream of `attachForListen`.
  let sdkOnMessage = wire.onmessage;
  const tap = (message: JSONRPCMessage): void => {
    attachForListen(message);
    sdkOnMessage?.(message);
  };
  Object.defineProperty(wire, 'onmessage', {
    configurable: true,
    enumerable: true,
    get: () => tap,
    set: (next: typeof sdkOnMessage) => {
      sdkOnMessage = next;
    },
  });

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

// ═══════════════════════════════════════════════════════════════
// http
// ═══════════════════════════════════════════════════════════════

const MAX_REQUEST_BODY_BYTES = parseEnvInt(
  'FS_CONTEXT_MAX_REQUEST_BYTES',
  4 * MIB,
  1024,
  256 * MIB,
);

/** The request id of a parsed JSON-RPC body, for error-envelope echo. */
function jsonRpcRequestId(parsedBody: unknown): string | number | null {
  const id = (parsedBody as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function errorHandlerMiddleware(
  err: Error & { status?: number },
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (err.status === 413) {
    sendJsonRpcError(res, 413, ProtocolErrorCode.InvalidRequest, 'Request body too large');
    return;
  }
  if (err.status === 400) {
    sendJsonRpcError(res, 400, ProtocolErrorCode.ParseError, 'Invalid JSON in request body');
    return;
  }
  next(err);
}

/** The `resourceSubscriptions` URIs of a `subscriptions/listen` body, de-duplicated. */
export function listenSubscriptionUris(parsedBody: unknown): string[] {
  if (typeof parsedBody !== 'object' || parsedBody === null) return [];
  const body = parsedBody as {
    method?: unknown;
    params?: { notifications?: { resourceSubscriptions?: unknown } };
  };
  if (body.method !== 'subscriptions/listen') return [];
  const uris = body.params?.notifications?.resourceSubscriptions;
  if (!Array.isArray(uris)) return [];
  // De-duplicate: one attach must yield one ref-count, or the release below
  // decrements further than it incremented and tears down a live watcher.
  return [...new Set(uris.filter((uri): uri is string => typeof uri === 'string'))];
}

/**
 * Attach filesystem watchers for the URIs named in a `subscriptions/listen`
 * filter. Returns the URIs that actually got a watcher, so the caller can
 * release exactly those when the stream ends.
 */
async function attachListenWatchers(
  parsedBody: unknown,
  pathGuard: PathGuard,
  registry: WatcherRegistry,
  notifier: ServerNotifier,
): Promise<string[]> {
  const uris = listenSubscriptionUris(parsedBody);
  if (uris.length === 0) return [];
  const sink = (uri: string): void => {
    notifier.resourceUpdated(uri);
  };
  const attached: string[] = [];
  for (const uri of uris) {
    try {
      if ((await attachFileWatcherForUri(registry, pathGuard, uri, sink)).ok) {
        attached.push(uri);
      }
    } catch (err: unknown) {
      Logger.warn(
        `[HTTP] listen watcher attach failed for ${uri}:`,
        formatUnknownErrorMessage(err),
      );
    }
  }
  return attached;
}

function makeHttpModernFactory(
  options: ServerOptions,
  getNotifier: () => ServerNotifier,
  sharedRegistry: WatcherRegistry,
  sharedPathGuard: PathGuard,
  sharedStore: ResourceStore,
): McpServerFactory {
  return async ({ era }) => {
    const notifier = getNotifier();
    const c = await createServer(options, {
      watcherRegistry: sharedRegistry,
      notifier,
      pathGuard: sharedPathGuard,
      resourceStore: sharedStore,
      era,
    });
    const previousOnClose = c.mcp.server.onclose;
    c.mcp.server.onclose = () => {
      previousOnClose?.();
      c.disposeRuntimeState();
    };
    return c.mcp;
  };
}

function setupExpressApp(
  httpHost: string,
  apiKey: string | undefined,
  allowedHosts: string[],
  modernNodeHandler: (req: Request, res: Response, parsedBody?: unknown) => Promise<void>,
  sharedPathGuard: PathGuard,
  sharedRegistry: WatcherRegistry,
  notifier: ServerNotifier,
): Express {
  const allowedOriginHostnames = computeAllowedOriginHostnames(
    process.env['FILESYSTEM_MCP_ALLOWED_ORIGINS'],
  );

  const app = createMcpExpressApp({
    host: httpHost,
    jsonLimit: `${MAX_REQUEST_BODY_BYTES}b`,
    ...(allowedHosts.length > 0 ? { allowedHosts: [...allowedHosts] } : {}),
    ...(allowedOriginHostnames.length > 0 ? { allowedOrigins: [...allowedOriginHostnames] } : {}),
  });

  const trustProxy = resolveTrustProxySetting(process.env['FILESYSTEM_MCP_TRUST_PROXY']);
  if (trustProxy !== undefined) {
    app.set('trust proxy', trustProxy);
  }

  if (allowedHosts.length === 0) {
    Logger.warn(
      '[HTTP] FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS is set: binding globally without Host validation.',
    );
  }

  app.options('/mcp', corsPreflightHandler(allowedOriginHostnames));
  app.use('/mcp', corsOriginMiddleware(allowedOriginHostnames));

  if (apiKey) {
    const rpm = parseEnvInt('FILESYSTEM_MCP_RATE_LIMIT_RPM', 120, 1, 100_000);
    app.use('/mcp', createRateLimiter(rpm));
  }

  if (apiKey && allowedHosts.length > 0) {
    const metadataHandler = (req: Request, res: Response): void => {
      const resource = protectedResourceUrl(req, true);
      if (!resource) {
        // Unreachable for the unrestricted case (the gate above excludes it),
        // but defend a FILESYSTEM_MCP_PUBLIC_URL parse failure with a bodyless
        // 404 — a generic OAuth client cannot parse a JSON-RPC error envelope.
        res.status(404).end();
        return;
      }
      res.header('Access-Control-Allow-Origin', '*');
      res.status(200).json({
        resource: resource.href,
        bearer_methods_supported: ['header'],
        resource_name: 'filesystem-mcp',
      });
    };
    app.get(
      ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
      metadataHandler,
    );
  }

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
    });
  });

  app.use('/mcp', bearerAuthMiddleware(apiKey, allowedHosts.length > 0));

  app.post('/mcp', (req: Request, res: Response, next: NextFunction) => {
    const parsedBody = req.body as unknown;
    // Reject an over-cap listen before the ack so the client does not believe
    // every requested URI is watched when the watcher budget is exhausted.
    const requestedUris = listenSubscriptionUris(parsedBody);
    // Only URIs without a live watcher consume a slot; a re-listen to an
    // already-watched URI just adds a callback (attachFileWatcherForUri
    // short-circuits on hasWatcher), so it must not count against capacity.
    const newUris = requestedUris.filter((uri) => !sharedRegistry.hasWatcher(uri));
    // Pre-check against *remaining* capacity so a registry already near the cap
    // rejects the batch pre-ack instead of silently dropping URIs. Best-effort:
    // a concurrent listen can still race past this and be dropped at attach by
    // `isAtCap` — but that path already logs and the client gets no ack for it.
    const available = MAX_WATCHERS - sharedRegistry.size();
    if (newUris.length > available) {
      sendJsonRpcError(
        res,
        400,
        ProtocolErrorCode.InvalidParams,
        `subscriptions/listen names ${newUris.length} not-yet-watched URIs but only ${available} watcher slots remain (cap ${MAX_WATCHERS}). Reduce the resourceSubscriptions list.`,
        jsonRpcRequestId(parsedBody),
      );
      return;
    }
    // Best-effort: fire-and-forget so a watcher error never blocks the request.
    void attachListenWatchers(parsedBody, sharedPathGuard, sharedRegistry, notifier)
      .then((attached) => {
        if (attached.length === 0) return;
        // The listen stream IS this POST's SSE response, so its close is the
        // teardown hook the SDK handler does not expose. `remove` ref-counts by
        // URI, so a watcher another stream also holds survives. The attach is
        // async, so the response may already be gone — release now if so.
        const release = (): void => {
          for (const uri of attached) sharedRegistry.remove(uri);
        };
        if (res.writableEnded || res.destroyed) release();
        else res.once('close', release);
      })
      .catch((err: unknown) => {
        Logger.warn('[HTTP] listen watcher attach error:', formatUnknownErrorMessage(err));
      });
    modernNodeHandler(req, res, parsedBody).catch(next);
  });

  app.all('/mcp', (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'POST, OPTIONS').end();
  });

  app.use(errorHandlerMiddleware);

  app.use((err: Error, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    Logger.error('[HTTP] Unhandled middleware error:', formatUnknownErrorMessage(err));
    sendJsonRpcError(res, 500, ProtocolErrorCode.InternalError, 'Internal Server Error');
  });

  return app;
}

export async function startHttpServer(port: number, options: ServerOptions): Promise<Server> {
  const httpHost = process.env['HTTP_HOST'] ?? '127.0.0.1';
  const apiKey = process.env['API_KEY'];
  assertHttpBindingPolicy(httpHost, apiKey);
  // A multi-instance HTTP fleet needs a shared requestState key; refuse to boot
  // when API_KEY is set and the key is missing/weak (see input-required.ts).
  assertFleetRequestStateKey();
  const allowedHosts = resolveAllowedHosts(httpHost, process.env['FILESYSTEM_MCP_ALLOWED_HOSTS']);
  assertHttpHostPolicy(
    httpHost,
    allowedHosts,
    process.env['FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS'] === '1',
  );

  if (apiKey) {
    Logger.warn(
      "[HTTP] subscriptions/listen resource_updated events are delivered on the handler's default in-process bus. A multi-instance fleet behind a load balancer needs a shared backend, passed via createMcpHandler's bus option, or events on one instance will not reach listeners on another. See README.md#multi-instance-http-deployments for an example.",
    );
  }
  const sharedRegistry = createWatcherRegistry();
  // One store for the whole endpoint, same lifetime and same one-credential
  // trust argument as the shared guard below: a result a tool externalized in
  // one POST must survive to the follow-up resources/read, and the modern leg
  // builds a fresh McpServer per request so a per-request store would discard
  // it immediately.
  const sharedStore = new ResourceStore();
  // One guard for the whole endpoint. The modern leg builds a fresh McpServer
  // per request, so a per-instance guard would discard every accepted access
  // grant the moment the request ended — re-prompting on each subsequent call
  // and leaving the listen-watcher path validating against a stale allowed set.
  // Grant scope is therefore the endpoint, not the connection: with API_KEY set
  // every caller presents the same key (one auth context by construction), and
  // without it the bind is loopback-only. Split into per-auth-context guards if
  // this ever serves more than one credential.
  const sharedPathGuard = new PathGuard(options, true);
  await sharedPathGuard.recomputeAllowedDirectories();

  const modernHandler: McpHttpHandler = createMcpHandler(
    makeHttpModernFactory(
      options,
      () => modernHandler.notify,
      sharedRegistry,
      sharedPathGuard,
      sharedStore,
    ),
    {
      legacy: 'reject',
      onerror: (error: Error) => {
        Logger.error('[HTTP] modern leg error:', formatUnknownErrorMessage(error));
      },
    },
  );
  const modernNodeHandler = toNodeHandler(modernHandler);

  const app = setupExpressApp(
    httpHost,
    apiKey,
    allowedHosts,
    modernNodeHandler,
    sharedPathGuard,
    sharedRegistry,
    modernHandler.notify,
  );

  const httpServer = createHttpServer(app);
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = DEFAULT_REQUEST_TIMEOUT_MSEC;
  httpServer.keepAliveTimeout = 5_000;

  const onHttpServerError = (error: Error): void => {
    Logger.error('[HTTP] runtime server error', {
      host: httpHost,
      port,
      error: formatUnknownErrorMessage(error),
    });
  };
  httpServer.on('error', onHttpServerError);

  const originalClose = httpServer.close.bind(httpServer);
  httpServer.close = function (callback?: (error?: Error) => void) {
    sharedRegistry.destroy();
    modernHandler
      .close()
      .then(() => {
        originalClose(callback);
      })
      .catch((err: unknown) => {
        Logger.error(
          '[HTTP] Error closing handler during HTTP server close:',
          formatUnknownErrorMessage(err),
        );
        originalClose(callback);
      });
    return httpServer;
  };

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      sharedRegistry.destroy();
      modernHandler.close().catch((closeErr: unknown) => {
        Logger.error(
          '[HTTP] Error closing handler on startup failure:',
          formatUnknownErrorMessage(closeErr),
        );
      });
      reject(err);
    };
    httpServer.once('error', onError);

    httpServer.listen(port, httpHost, () => {
      httpServer.removeListener('error', onError);
      Logger.info(`[HTTP] Server listening on http://${httpHost}:${port}`);
      resolve(httpServer);
    });
  });
}
