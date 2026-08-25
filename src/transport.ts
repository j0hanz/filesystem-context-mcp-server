import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type {
  JSONRPCMessage,
  McpHttpHandler,
  McpServerFactory,
  MessageExtraInfo,
  ServerEventBus,
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/server';
import {
  createMcpHandler,
  DEFAULT_REQUEST_TIMEOUT_MSEC,
  JSONRPC_VERSION,
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

/**
 * Runtime inputs the CLI resolves once (flag, else the operator's env var) and
 * hands the transport. Separate from `ServerOptions` because that object is
 * `PathGuard`'s constructor argument: the filesystem guard has no use for a
 * bind address and no business holding a bearer secret.
 */
export interface RuntimeConfig {
  /** `--http-host` or `HTTP_HOST`. The HTTP bind defaults to loopback without it. */
  httpHost?: string;
  /** `--api-key` or `API_KEY`. Unset means open access (loopback dev mode). */
  apiKey?: string;
  /** Shared change-event bus for multi-instance HTTP deployments. Caller-owned. */
  eventBus?: ServerEventBus;
}

/** A gate either lets the message through to the SDK or answers it itself. */
interface InboundGate {
  /**
   * Cheap synchronous test for "does this message need gating at all". Only a
   * message that answers `true` enters the serialized queue below; everything
   * else is forwarded on the spot, so one slow gate run cannot stall the
   * connection's other traffic (a `notifications/cancelled` for the very
   * request being gated, most of all).
   */
  applies(message: JSONRPCMessage): boolean;
  run(
    message: JSONRPCMessage,
  ): Promise<{ action: 'forward' } | { action: 'respond'; message: JSONRPCMessage }>;
}

class GatedStdioTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  readonly #inner: StdioServerTransport;
  readonly #gate: InboundGate;
  #incoming = Promise.resolve();

  constructor(inner: StdioServerTransport, gate: InboundGate) {
    this.#inner = inner;
    this.#gate = gate;
  }

  async start(): Promise<void> {
    this.#inner.onclose = () => {
      this.onclose?.();
    };
    this.#inner.onerror = (error) => {
      this.onerror?.(error);
    };
    this.#inner.onmessage = (message: JSONRPCMessage) => {
      if (!this.#gate.applies(message)) {
        this.onmessage?.(message);
        return;
      }
      // Gated messages stay ordered among themselves: two listens naming the
      // same URI must not race the registry's ref-count.
      this.#incoming = this.#incoming
        .then(async () => {
          const result = await this.#gate.run(message);
          if (result.action === 'respond') {
            await this.#inner.send(result.message);
            return;
          }
          this.onmessage?.(message);
        })
        .catch(async (error: unknown) => {
          const failure =
            error instanceof Error ? error : new Error(formatUnknownErrorMessage(error));
          this.onerror?.(failure);
          // The gate swallowed the message, so nothing downstream will answer
          // it. Without this the client waits out its whole request timeout.
          const id = jsonRpcRequestId(message);
          if (id === null) return;
          await this.#inner
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
    await this.#inner.start();
  }

  // `TransportSendOptions` is accepted and dropped: `StdioServerTransport.send`
  // takes no options (one shared channel, so there is no per-request stream to
  // relate an outbound message to). Declaring the parameter keeps the wrapper
  // substitutable for the inner transport if the SDK ever starts passing one.
  send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    return this.#inner.send(message);
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}

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

  const rawWire = new StdioServerTransport();
  const wire = new GatedStdioTransport(rawWire, {
    applies: (message) => listenSubscriptionUris(message).length > 0,

    // Every lease this takes is held for the rest of the connection: stdio has
    // no per-stream close hook, so nothing releases them and `registry.destroy`
    // at close is the only teardown. That covers a listen the SDK goes on to
    // reject too — the watcher stays until the connection ends, bounded by
    // MAX_WATCHERS. Per-subscription release needs the id the unsubscribe
    // contract does not carry (see watcher-registry.ts).
    run: async (message) => {
      const id = jsonRpcRequestId(message);
      const ctx = activeCtx;
      if (id === null || !ctx) return { action: 'forward' };

      const prepared = await prepareListenWatchers(message, ctx.pathGuard, registry, sink);
      if (prepared.ok) return { action: 'forward' };

      return {
        action: 'respond',
        message: {
          jsonrpc: JSONRPC_VERSION,
          id,
          error: {
            code: ProtocolErrorCode.InvalidParams,
            message: prepared.message,
          },
        },
      };
    },
  });
  const handle = serveStdio(factory, {
    legacy: 'serve',
    transport: wire,
    onerror: (error: unknown) => {
      Logger.error('[Stdio] serve error:', formatUnknownErrorMessage(error));
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
 * The code the SDK's own non-POST rejection carries. Not a `ProtocolErrorCode`
 * member — the enum has no `-32000` — so it is pinned here to keep the local
 * 405 envelope identical to the one the handler would have produced.
 */
const SDK_METHOD_NOT_ALLOWED_CODE = -32000;

type ListenPreparation =
  | { readonly ok: true; readonly acquiredUris: string[] }
  | { readonly ok: false; readonly message: string };

const WATCHER_FAILURE_REASONS = {
  'bad-uri': 'unsupported resource URI',
  capped: `watcher limit ${MAX_WATCHERS} reached`,
  'attach-failed': 'filesystem watcher could not be created',
  stale: 'subscription was cancelled during setup',
} as const;

function watcherFailureMessage(
  uri: string,
  result: Exclude<Awaited<ReturnType<typeof attachFileWatcherForUri>>, { ok: true }>,
): string {
  const why =
    result.reason === 'invalid-path'
      ? formatUnknownErrorMessage(result.error)
      : WATCHER_FAILURE_REASONS[result.reason];
  return `Cannot subscribe to ${uri}: ${why}`;
}

/**
 * Prepare every filesystem watcher named by a `subscriptions/listen` filter.
 * The batch is all-or-nothing: a failed URI releases each prior lease.
 */
async function prepareListenWatchers(
  parsedBody: unknown,
  pathGuard: PathGuard,
  registry: WatcherRegistry,
  notify: (uri: string) => void,
): Promise<ListenPreparation> {
  const uris = listenSubscriptionUris(parsedBody);
  const acquired: string[] = [];
  for (const uri of uris) {
    const result = await attachFileWatcherForUri(registry, pathGuard, uri, notify);
    if (!result.ok) {
      for (const prior of acquired) registry.release(prior);
      return { ok: false, message: watcherFailureMessage(uri, result) };
    }
    acquired.push(uri);
  }
  return { ok: true, acquiredUris: acquired };
}

function makeHttpModernFactory(
  options: ServerOptions,
  getNotifier: () => ServerNotifier,
  sharedRegistry: WatcherRegistry,
  sharedPathGuard: PathGuard,
  sharedStore: ResourceStore,
  apiKey: string | undefined,
): McpServerFactory {
  return async ({ era }) => {
    const notifier = getNotifier();
    const c = await createServer(options, {
      watcherRegistry: sharedRegistry,
      notifier,
      pathGuard: sharedPathGuard,
      resourceStore: sharedStore,
      era,
      ...(apiKey !== undefined ? { apiKey } : {}),
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
  // Read once here and passed down, like every other env-derived policy input:
  // http-policy holds no state and reads no env of its own.
  const publicUrl = process.env['FILESYSTEM_MCP_PUBLIC_URL'];

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
      const resource = protectedResourceUrl(req, true, publicUrl);
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

  app.use('/mcp', bearerAuthMiddleware(apiKey, allowedHosts.length > 0, publicUrl));

  const resourceUpdateSink = (uri: string): void => {
    notifier.resourceUpdated(uri);
  };

  app.post('/mcp', (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const parsedBody = req.body as unknown;
      // Reject an over-cap listen before the ack so the client does not believe
      // every requested URI is watched when the watcher budget is exhausted.
      const requestedUris = listenSubscriptionUris(parsedBody);
      // Only URIs without a live watcher consume a slot; a re-listen to an
      // already-watched URI just retains another lease.
      const newUris = requestedUris.filter((uri) => !sharedRegistry.hasWatcher(uri));
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

      const prepared = await prepareListenWatchers(
        parsedBody,
        sharedPathGuard,
        sharedRegistry,
        resourceUpdateSink,
      );
      if (!prepared.ok) {
        sendJsonRpcError(
          res,
          400,
          ProtocolErrorCode.InvalidParams,
          prepared.message,
          jsonRpcRequestId(parsedBody),
        );
        return;
      }

      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        for (const uri of prepared.acquiredUris) sharedRegistry.release(uri);
      };
      if (prepared.acquiredUris.length > 0) {
        // The attach loop awaits per-URI path validation, so the client can be
        // gone by the time it returns. `close` fires once: a listener attached
        // after it would never run and every lease this batch took would leak
        // until process shutdown.
        if (res.closed || res.destroyed || res.writableEnded) release();
        else res.once('close', release);
      }

      try {
        await modernNodeHandler(req, res, parsedBody);
      } catch (error) {
        release();
        throw error;
      }
    })().catch(next);
  });

  // Answer non-POST here rather than handing it to `modernNodeHandler`. The
  // SDK's own 405 is byte-identical to this one, but it omits the `Allow`
  // header RFC 9110 §15.5.6 requires and routes every routine GET probe through
  // the handler's `onerror` — which this server logs at error level.
  app.all('/mcp', (_req: Request, res: Response) => {
    sendJsonRpcError(res, 405, SDK_METHOD_NOT_ALLOWED_CODE, 'Method not allowed.', null, {
      Allow: 'POST, OPTIONS',
    });
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

export async function startHttpServer(
  port: number,
  options: ServerOptions,
  config: RuntimeConfig = {},
): Promise<Server> {
  const httpHost = config.httpHost ?? '127.0.0.1';
  const { apiKey, eventBus } = config;
  assertHttpBindingPolicy(httpHost, apiKey);
  // A multi-instance HTTP fleet needs a shared requestState key; refuse to boot
  // when an API key is set and the key is missing/weak (see input-required.ts).
  assertFleetRequestStateKey(apiKey);
  const allowedHosts = resolveAllowedHosts(httpHost, process.env['FILESYSTEM_MCP_ALLOWED_HOSTS']);
  assertHttpHostPolicy(
    httpHost,
    allowedHosts,
    process.env['FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS'] === '1',
  );

  if (apiKey && !eventBus) {
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
  // Fires only from a tool call, which is long after `modernHandler` below is
  // constructed, so reading it from the closure is safe (same as `getNotifier`).
  const sharedStore = new ResourceStore(() => {
    modernHandler.notify.resourcesChanged();
  });
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
      apiKey,
    ),
    {
      legacy: 'reject',
      ...(eventBus ? { bus: eventBus } : {}),
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
