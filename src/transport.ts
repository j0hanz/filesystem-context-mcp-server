import { createMcpExpressApp } from '@modelcontextprotocol/express';
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from '@modelcontextprotocol/node';
import type {
  EventId,
  EventStore,
  JSONRPCMessage,
  McpServerFactory,
  RequestId,
  StreamId,
} from '@modelcontextprotocol/server';
import {
  createMcpHandler,
  DEFAULT_REQUEST_TIMEOUT_MSEC,
  InMemoryServerEventBus,
  isInitializedNotification,
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  isLegacyRequest,
  JSONRPC_VERSION,
  parseJSONRPCMessage,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
// Moved to a Node-only subpath export upstream (not re-exported from the
// package root, which stays platform-agnostic for non-Node runtimes).
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';

import type { Express, NextFunction, Request, Response } from 'express';

import { ErrorCode, formatUnknownErrorMessage, FsError } from './core/errors.js';
import { Logger, withSession } from './core/observability.js';
import { PathGuard } from './core/path.js';
import type { ServerOptions } from './core/path.js';
import type { McpRootsSynchronizer } from './core/registrar.js';
import { getInitHandshakeTimeoutMs, INIT_TIMEOUT_CLOSE, parseEnvInt } from './core/util.js';
import { createWatcherRegistry, type WatcherRegistry } from './core/watcher-registry.js';
import {
  assertHttpBindingPolicy,
  assertHttpHostPolicy,
  bearerAuthMiddleware,
  computeAllowedOriginHostnames,
  corsPreflightHandler,
  createRateLimiter,
  protectedResourceUrl,
  resolveAllowedHosts,
  resolveTrustProxySetting,
} from './http-policy.js';
import { attachFileWatcherForUri } from './resources.js';
import type { FilesystemServerContext } from './server.js';
import { createServer } from './server.js';

// ═══════════════════════════════════════════════════════════════
// event-store
// ═══════════════════════════════════════════════════════════════

const MAX_EVENTS_PER_STREAM = 1000;
const MAX_EVENT_STREAMS = 1000;

interface StoredEvent {
  readonly id: EventId;
  readonly message: JSONRPCMessage;
}

/**
 * Bounded in-memory ring buffer supporting resumable streams (`Last-Event-ID`).
 * Each stream keeps at most `MAX_EVENTS_PER_STREAM` events (FIFO eviction);
 * events are lost across process restarts and once evicted, matching the
 * "best-effort" resumability contract of the streamable HTTP transport.
 *
 * ONE STORE PER SESSION. The SDK keys the standalone SSE stream with a constant
 * (`"_GET_stream"`) and per-request streams with a fresh UUID — never with the
 * session id. A store shared across sessions would therefore merge every
 * session's GET-stream events into one buffer, so a `Last-Event-ID` resume
 * would replay other sessions' notifications to the resuming client, and no
 * session teardown could identify which streams to drop.
 */
export class InMemoryEventStore implements EventStore {
  private readonly streams = new Map<StreamId, StoredEvent[]>();
  private readonly eventIdToStreamId = new Map<EventId, StreamId>();

  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = randomUUID();
    let stream = this.streams.get(streamId);
    if (!stream) {
      stream = [];
    } else {
      this.streams.delete(streamId);
    }
    this.streams.set(streamId, stream);

    stream.push({ id: eventId, message });
    this.eventIdToStreamId.set(eventId, streamId);

    if (stream.length > MAX_EVENTS_PER_STREAM) {
      const removed = stream.shift();
      if (removed) {
        this.eventIdToStreamId.delete(removed.id);
      }
    }

    if (this.streams.size > MAX_EVENT_STREAMS) {
      // Map preserves insertion order: the first key is the oldest stream.
      const oldestStreamId = this.streams.keys().next().value;
      if (oldestStreamId !== undefined) {
        const evicted = this.streams.get(oldestStreamId);
        this.streams.delete(oldestStreamId);
        if (evicted) {
          for (const { id } of evicted) {
            this.eventIdToStreamId.delete(id);
          }
        }
      }
    }

    return Promise.resolve(eventId);
  }

  getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return Promise.resolve(this.eventIdToStreamId.get(eventId));
  }

  async replayEventsAfter(
    lastEventId: EventId,
    callbacks: {
      send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>;
    },
  ): Promise<StreamId> {
    const streamId = this.eventIdToStreamId.get(lastEventId);
    if (!streamId) {
      throw new FsError(ErrorCode.NOT_FOUND, `Event ID ${lastEventId} not found or expired`);
    }

    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new FsError(ErrorCode.NOT_FOUND, `Stream ${streamId} not found`);
    }

    const eventIndex = stream.findIndex((event) => event.id === lastEventId);
    if (eventIndex === -1) {
      throw new FsError(
        ErrorCode.NOT_FOUND,
        `Event ID ${lastEventId} not found in stream ${streamId}`,
      );
    }

    for (let i = eventIndex + 1; i < stream.length; i++) {
      const event = stream[i];
      if (event) {
        await callbacks.send(event.id, event.message);
      }
    }

    return streamId;
  }

  clear(): void {
    this.streams.clear();
    this.eventIdToStreamId.clear();
  }
}

/**
 * Serve filesystem-mcp over stdio, both eras. `serveStdio(factory, { legacy:
 * 'serve' })` calls the factory once per connection (plus one discarded
 * `server/discover` probe instance if the client falls back to `initialize`);
 * the factory builds a fresh `FilesystemServerContext` via `createServer`.
 *
 * On a `legacy` opening the roots synchronizer is armed (the 2025 push-style
 * `listRoots()`/`getClientCapabilities()` path is correct there); on a
 * `modern` opening it is omitted — those methods throw on the 2026-07-28 era,
 * so allowed directories come from configuration (`recomputeAllowedDirectories`
 * already ran inside `createServer`).
 *
 * Unlike the old hand-wired transport, `createServer` now runs on the first
 * inbound message, so a bad config surfaces as a serve-time error (reported
 * via `onerror`) rather than at process boot — inherent to `serveStdio`.
 */
export function startServer(options: ServerOptions): StdioServerHandle {
  let activeCtx: FilesystemServerContext | undefined;
  const factory: McpServerFactory = async (ctx) => {
    const c = await createServer(options);
    if (ctx.era === 'legacy') {
      c.synchronizer.registerHandlers(
        c.mcp,
        INIT_TIMEOUT_CLOSE
          ? () => {
              c.mcp.close().catch((err: unknown) => {
                Logger.error('[Stdio] init-timeout close error:', formatUnknownErrorMessage(err));
              });
            }
          : undefined,
      );
      c.synchronizer.logMissingDirectoriesIfNeeded();
    } else {
      c.synchronizer.markInitialized();
    }
    activeCtx = c;
    return c.mcp;
  };

  const handle = serveStdio(factory, {
    legacy: 'serve',
    onerror: (error: unknown) => {
      Logger.error('[Stdio] serve error:', formatUnknownErrorMessage(error));
    },
  });

  // Wrap so shutdown runs our per-connection disposal (registrars/watcher
  // state) before the SDK tears the transport down. disposeRuntimeState is
  // idempotent, so this is safe even if the SDK already closed the instance.
  return {
    close: () =>
      (async () => {
        try {
          activeCtx?.disposeRuntimeState();
        } catch {
          /* idempotent — disposeRuntimeState guards cleanedUp */
        }
        activeCtx = undefined;
        await handle.close();
      })(),
  };
}

const MAX_SESSION_ID_LENGTH = 256;

// Session ids must be non-empty, printable, and whitespace-free. The SDK's
// default generator emits crypto.randomUUID() (UUID v4), which satisfies this;
// the guard blocks control chars / whitespace without over-restricting custom
// opaque tokens.
// eslint-disable-next-line no-control-regex -- intentionally reject control chars at this trust boundary
const SESSION_ID_CHARSET_RE = /^[^\s\x00-\x1F\x7F]+$/u;

/** Structural session-id check: non-empty, ≤ max length, printable, no whitespace. */
export function isValidSessionId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_SESSION_ID_LENGTH && SESSION_ID_CHARSET_RE.test(id);
}

/**
 * Wire shape for a JSON-RPC error emitted outside the transport's own dispatch.
 * `id` echoes the request when one was parsed, and is `null` when it was not —
 * the form JSON-RPC 2.0 mandates for errors raised before a request is
 * identified. The SDK's `JSONRPCErrorResponse` models `id` as
 * optional-but-never-null, so this is deliberately its own type rather than a
 * cast. Only ever handed to `JSON.stringify`.
 */
interface PreDispatchJsonRpcError {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId | null;
  error: { code: number; message: string };
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  id: RequestId | null = null,
): void {
  const body: PreDispatchJsonRpcError = {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message },
  };
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function getSessionId(req: IncomingMessage): string | undefined {
  const rawSessionId = req.headers['mcp-session-id'];
  if (typeof rawSessionId !== 'string' || !isValidSessionId(rawSessionId)) return undefined;
  return rawSessionId;
}

// ---------------------------------------------------------------------------
// HttpSessionRegistry — owns session map, sweep timer, log-router wiring
// ---------------------------------------------------------------------------

interface HttpSession {
  synchronizer: McpRootsSynchronizer;
  transport: NodeStreamableHTTPServerTransport;
  createdAt: number;
  /** When the last request on this session finished; drives idle eviction. */
  lastActiveAt: number;
  /** Requests currently in flight, including long-lived GET/SSE streams. */
  activeRequests: number;
  close: () => Promise<void>;
}

interface HttpSessionRegistryOptions {
  handshakeTimeoutMs: number;
  idleTimeoutMs: number;
}

/**
 * Single source of truth for the live HTTP session set. Replaces the previous
 * pair of parallel maps (`sessions` + `activeServers`) and the inline sweep
 * timer in `startHttpServer`. HTTP-specific by design — stdio has no sessions.
 */
class HttpSessionRegistry {
  private readonly sessions = new Map<string, HttpSession>();

  private readonly handshakeTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(opts: HttpSessionRegistryOptions) {
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs;
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.sweepIntervalMs = opts.handshakeTimeoutMs * 2;
  }

  size(): number {
    return this.sessions.size;
  }

  get(sessionId: string): HttpSession | undefined {
    return this.sessions.get(sessionId);
  }

  add(sessionId: string, session: HttpSession): void {
    this.sessions.set(sessionId, session);
  }

  // The session's own event store is cleared by its cleanup(), which runs
  // before this — the registry owns no cross-session event state.
  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  getOrRespondNotFound(sessionId: string, res: ServerResponse): HttpSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      sendJsonRpcError(res, 404, ProtocolErrorCode.InvalidRequest, 'Session not found');
      return undefined;
    }
    return session;
  }

  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.sweepStale();
    }, this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  private closingSessionIds = new Set<string>();

  /**
   * Why a session is evictable, or undefined when it is not.
   *
   * Two clocks, because a session goes stale in two different ways: it never
   * finishes the handshake, or it finishes and is then abandoned. Streamable
   * HTTP has no connection to lose — a client that stops calling without
   * sending DELETE would otherwise hold its server, watchers, and session slot
   * until the process exits, and once `maxSessions` slots are held that way,
   * every new initialize gets 503 forever.
   *
   * `activeRequests` is what keeps the idle clock honest: a client parked on a
   * long-lived GET stream sends nothing for hours and is not idle.
   */
  private evictionReason(session: HttpSession, now: number): string | undefined {
    if (!session.synchronizer.isInitialized()) {
      return now - session.createdAt > this.handshakeTimeoutMs ? 'handshake timeout' : undefined;
    }
    if (session.activeRequests > 0) return undefined;
    return now - session.lastActiveAt > this.idleTimeoutMs ? 'idle timeout' : undefined;
  }

  private sweepStale(): void {
    const now = Date.now();
    const staleSessionIds: [string, string][] = [];
    for (const [sessionId, session] of this.sessions) {
      if (this.closingSessionIds.has(sessionId)) continue;
      const reason = this.evictionReason(session, now);
      if (reason) {
        staleSessionIds.push([sessionId, reason]);
      }
    }

    for (const [sessionId, reason] of staleSessionIds) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      Logger.warn(`[HTTP] Evicting stale session ${sessionId} (${reason})`);
      this.closingSessionIds.add(sessionId);
      session
        .close()
        .catch((err: unknown) => {
          Logger.error(
            `[HTTP] Error closing stale session ${sessionId}:`,
            formatUnknownErrorMessage(err),
          );
          this.remove(sessionId);
        })
        .finally(() => {
          this.closingSessionIds.delete(sessionId);
        });
    }
  }

  private isClosing = false;

  isShuttingDown(): boolean {
    return this.isClosing;
  }

  async closeAll(): Promise<void> {
    this.isClosing = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    const closes = Array.from(this.sessions.values()).map((session) =>
      session.close().catch((err: unknown) => {
        Logger.error('[HTTP] Error closing session on shutdown:', formatUnknownErrorMessage(err));
      }),
    );
    await Promise.allSettled(closes);
  }
}

const MAX_REQUEST_BODY_BYTES = parseEnvInt(
  'FS_CONTEXT_MAX_REQUEST_BYTES',
  4 * 1024 * 1024,
  1024,
  256 * 1024 * 1024,
);

async function createHttpSession(
  options: ServerOptions,
  registry: HttpSessionRegistry,
): Promise<HttpSession> {
  const serverCtx = await createServer(options);
  const mcpServer = serverCtx.mcp;
  const pathGuard = serverCtx.pathGuard;
  const synchronizer = serverCtx.synchronizer;
  // Scoped to this session: see the InMemoryEventStore doc comment.
  const eventStore = new InMemoryEventStore();

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    serverCtx.disposeRuntimeState();
    eventStore.clear();
    const { sessionId } = transport;
    if (sessionId) {
      registry.remove(sessionId);
    }
  };

  synchronizer.registerHandlers(mcpServer, () => {
    cleanup();
    mcpServer.close().catch((err: unknown) => {
      Logger.error('Error closing MCP server on registry event:', formatUnknownErrorMessage(err));
    });
  });

  const close = async (): Promise<void> => {
    cleanup();
    await mcpServer.close();
  };

  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    eventStore,
    retryInterval: 2_000,
    onsessioninitialized: (sessionId) => {
      if (!pathGuard.isServerContext) {
        throw new FsError(
          ErrorCode.VALIDATION_FAILED,
          'PathGuard must be constructed with isServerContext for an HTTP session',
        );
      }
      // `session` is declared below and initialized before this can fire — the
      // callback runs while handling an initialize request, which cannot reach
      // the transport until createHttpSession has returned.
      registry.add(sessionId, session);
      synchronizer.logMissingDirectoriesIfNeeded();
    },
    onsessionclosed: async (sessionId) => {
      const session = registry.get(sessionId);
      if (session) {
        try {
          await session.close();
        } catch (err) {
          Logger.error(
            `[HTTP] Error closing session ${sessionId} in onsessionclosed:`,
            formatUnknownErrorMessage(err),
          );
        }
      }
    },
  });

  transport.onerror = (error: unknown) => {
    Logger.error('[HTTP] Transport error:', formatUnknownErrorMessage(error));
  };

  transport.onclose = cleanup;

  try {
    await mcpServer.connect(transport);
  } catch (error) {
    cleanup();
    throw error;
  }

  // One object, shared by the registry and the caller, so a request handled
  // through either path stamps the same activity clock.
  const now = Date.now();
  const session: HttpSession = {
    synchronizer,
    transport,
    createdAt: now,
    lastActiveAt: now,
    activeRequests: 0,
    close,
  };
  return session;
}

async function handleSessionTransportRequest(
  session: HttpSession,
  req: IncomingMessage,
  res: ServerResponse,
  body?: unknown,
): Promise<void> {
  session.activeRequests++;
  // 'close' fires for both a completed response and a client that hangs up
  // mid-stream, which is exactly when a long-lived GET stream stops counting
  // as activity. handleRequest returning is not the same moment.
  res.once('close', () => {
    session.activeRequests--;
    session.lastActiveAt = Date.now();
  });
  await withSession(session.transport.sessionId, async () => {
    await session.transport.handleRequest(req, res, body);
  });
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

async function handlePostMcp(
  req: Request,
  res: Response,
  options: ServerOptions,
  registry: HttpSessionRegistry,
): Promise<void> {
  const sessionId = getSessionId(req);
  // Hoisted so the catch below can echo the id back — a client awaiting a
  // response otherwise blocks to timeout on an uncorrelatable error.
  let requestId: RequestId | null = null;

  try {
    const body = req.body as unknown;
    let message: JSONRPCMessage;
    try {
      message = parseJSONRPCMessage(body);
    } catch {
      // Invalid JSON-RPC shape
      sendJsonRpcError(res, 400, ProtocolErrorCode.InvalidRequest, 'Invalid Request');
      return;
    }

    const isResponse = isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message);
    if (isJSONRPCRequest(message)) requestId = message.id;

    Logger.debug('[HTTP] inbound', {
      method: 'method' in message ? message.method : null,
      sessionId: sessionId ?? null,
    });
    if (isInitializedNotification(message)) {
      Logger.debug('[HTTP] initialized notification received', {
        sessionId: sessionId ?? null,
      });
    }

    if (sessionId) {
      const session = registry.getOrRespondNotFound(sessionId, res);
      if (session) {
        await handleSessionTransportRequest(session, req, res, message);
      }
      return;
    }

    // No session yet — only an initialize request may open one.
    if (isResponse) {
      sendJsonRpcError(
        res,
        400,
        ProtocolErrorCode.InvalidRequest,
        'JSON-RPC response or notification cannot start a new session',
      );
      return;
    }

    if (!isInitializeRequest(message)) {
      sendJsonRpcError(
        res,
        400,
        ProtocolErrorCode.InvalidRequest,
        'Bad Request: No valid session ID provided',
      );
      return;
    }
    const maxSessions = parseEnvInt('FILESYSTEM_MCP_MAX_HTTP_SESSIONS', 100, 1, 10_000);
    if (registry.size() >= maxSessions) {
      res.setHeader('Retry-After', '60');
      sendJsonRpcError(res, 503, ProtocolErrorCode.InternalError, 'Too many sessions');
      return;
    }
    const session = await createHttpSession(options, registry);
    try {
      await handleSessionTransportRequest(session, req, res, message);
    } catch (error) {
      try {
        await session.close();
      } catch (closeError) {
        Logger.error(
          '[HTTP] Error closing session after request failure:',
          formatUnknownErrorMessage(closeError),
        );
      }
      throw error;
    }
  } catch (error) {
    Logger.error('[HTTP] Error handling POST request:', formatUnknownErrorMessage(error));
    if (!res.headersSent) {
      sendJsonRpcError(
        res,
        500,
        ProtocolErrorCode.InternalError,
        'Internal Server Error',
        requestId,
      );
    }
    // Do NOT rethrow — an unhandled rejection here would trigger a process-wide shutdown.
    // The error is already logged, and we've sent a 500 response if possible.
  }
}

async function handleGetOrDeleteMcp(
  req: Request,
  res: Response,
  registry: HttpSessionRegistry,
): Promise<void> {
  const sessionId = getSessionId(req);

  try {
    if (!sessionId) {
      sendJsonRpcError(
        res,
        400,
        ProtocolErrorCode.InvalidRequest,
        'Bad Request: Missing session ID',
      );
      return;
    }
    const session = registry.getOrRespondNotFound(sessionId, res);
    if (session) {
      await handleSessionTransportRequest(session, req, res);
    }
  } catch (error) {
    Logger.error(`[HTTP] Error handling ${req.method} request:`, formatUnknownErrorMessage(error));
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, ProtocolErrorCode.InternalError, 'Internal Server Error');
    }
    // Do NOT rethrow — an unhandled rejection here would trigger a process-wide shutdown.
  }
}

function setupExpressApp(
  httpHost: string,
  apiKey: string | undefined,
  allowedHosts: string[],
  options: ServerOptions,
  registry: HttpSessionRegistry,
  modernNodeHandler: (req: Request, res: Response, parsedBody?: unknown) => Promise<void>,
  watcherPathGuard: PathGuard,
  sharedRegistry: WatcherRegistry,
  bus: InMemoryServerEventBus,
): Express {
  // Env-derived CORS origins (hostname-form, no scheme/port — matches the SDK
  // app's allowedOrigins consumer). The compute and the OPTIONS preflight
  // handler both live in http-policy; the same set is consulted end-to-end so
  // a remote origin allowed via FILESYSTEM_MCP_ALLOWED_ORIGINS is reflected in
  // Access-Control-Allow-Origin.
  const allowedOriginHostnames = computeAllowedOriginHostnames(
    process.env['FILESYSTEM_MCP_ALLOWED_ORIGINS'],
  );

  const app = createMcpExpressApp({
    host: httpHost,
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    // Origin validation is enforced by the SDK app itself (not left to its
    // localhost-bind-only default) so non-loopback binds are covered too —
    // matches the hostnames corsPreflightHandler reflects below.
    ...(allowedOriginHostnames.length > 0 ? { allowedOrigins: allowedOriginHostnames } : {}),
    jsonLimit: `${MAX_REQUEST_BODY_BYTES}b`,
  });

  // Express derives req.ip and req.secure from X-Forwarded-* only when told to
  // trust a proxy. Off by default: trusting those headers on a direct bind lets
  // any client forge its own address. Operators behind a TLS terminator set the
  // hop count (or a subnet expression Express understands).
  const trustProxy = resolveTrustProxySetting(process.env['FILESYSTEM_MCP_TRUST_PROXY']);
  if (trustProxy !== undefined) {
    app.set('trust proxy', trustProxy);
  }

  // createMcpExpressApp already mounts hostHeaderValidation(allowedHosts)
  // app-wide when the list is non-empty — a second /mcp-scoped copy here would
  // be dead code, since the app-wide check rejects first.
  if (allowedHosts.length === 0) {
    // Reachable only under FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS=1 —
    // assertHttpHostPolicy throws for a wildcard bind without allowed hosts.
    Logger.warn(
      '[HTTP] FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS is set: binding globally without Host validation.',
    );
  }

  app.options('/mcp', corsPreflightHandler(allowedOriginHostnames));

  // Rate-limit the public surface only: when an API key is set, bound the
  // request rate per client IP to deny online brute force of the bearer token.
  // Loopback dev mode (no key) stays unlimited. The OPTIONS preflight above
  // already ends the response, so CORS checks are not counted against the limit.
  if (apiKey) {
    const rpm = parseEnvInt('FILESYSTEM_MCP_RATE_LIMIT_RPM', 120, 1, 100_000);
    app.use('/mcp', createRateLimiter(rpm));
  }

  // Discovery is only truthful when a credential is actually required, and it
  // stays outside the bearer guard — a client reads it precisely because it
  // does not yet have a token. RFC 9728 §3.1 puts the document at the
  // well-known path with the resource's own path appended; the bare path is
  // served too, since clients that treat the origin as the resource probe it.
  if (apiKey) {
    const metadataHandler = (req: Request, res: Response): void => {
      const resource = protectedResourceUrl(req, allowedHosts.length > 0);
      if (!resource) {
        // The Host is unusable as a resource identifier and nothing else names
        // this server, so the request cannot be answered truthfully.
        sendJsonRpcError(
          res,
          400,
          ProtocolErrorCode.InvalidRequest,
          'Cannot derive a resource identifier from the Host header. Set FILESYSTEM_MCP_PUBLIC_URL.',
        );
        return;
      }
      // Wildcard is correct for this document and only this document: it is
      // public by design, carries no secret, and grants no session. The /mcp
      // routes stay on the reflected-allowlist policy above, where a wildcard
      // would let any page drive a session.
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
    if (registry.isShuttingDown()) {
      res.status(503).json({
        status: 'shutting_down',
        uptime: process.uptime(),
        sessions: registry.size(),
      });
      return;
    }
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      sessions: registry.size(),
    });
  });

  app.use('/mcp', bearerAuthMiddleware(apiKey, allowedHosts.length > 0));

  app.post('/mcp', (req: Request, res: Response, next: NextFunction) => {
    // Era-branch: a POST carrying the 2026-07-28 envelope routes to the
    // modern leg (per-request instances, subscriptions/listen over the shared
    // bus); everything else falls through to the 2025 sessionful stack, which
    // stays byte-for-byte unchanged. GET/DELETE are bodyless session ops that
    // isLegacyRequest always classifies legacy, so they never reach here.
    const parsedBody = req.body as unknown;
    toWebRequest(req, parsedBody)
      .then((probe) => isLegacyRequest(probe, parsedBody))
      .then((legacy) => {
        if (legacy) {
          handlePostMcp(req, res, options, registry).catch(next);
          return;
        }
        // Modern file-watch: a `subscriptions/listen` stream narrows by
        // resourceSubscriptions, but the SDK owns the listen router and gives the
        // server no per-client filter hook — so attach filesystem watchers for the
        // requested URIs here (the shared registry + bus persist across per-request
        // instances). The bus publishes resource_updated; the router narrows per
        // stream. Attach errors are swallowed so the listen stream still opens.
        attachListenWatchers(parsedBody, watcherPathGuard, sharedRegistry, bus)
          .catch((err: unknown) => {
            Logger.warn('[HTTP] listen watcher attach error:', formatUnknownErrorMessage(err));
          })
          .then(() => modernNodeHandler(req, res, parsedBody))
          .catch(next);
      })
      .catch(next);
  });

  const getOrDeleteHandler = (req: Request, res: Response, next: NextFunction) => {
    handleGetOrDeleteMcp(req, res, registry).catch(next);
  };

  app.get('/mcp', getOrDeleteHandler);
  app.delete('/mcp', getOrDeleteHandler);

  app.all('/mcp', (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'GET, POST, DELETE, OPTIONS').end();
  });

  app.use(errorHandlerMiddleware);

  // Catch-all error handler for any middleware that throws. Express docs say to
  // put this last, and to check res.headersSent before sending a response.
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

/**
 * Attach filesystem watchers for the URIs named in a `subscriptions/listen`
 * filter. The SDK owns the listen router and gives the server no per-client
 * filter hook, so this reads the filter off the already-parsed POST body (the
 * documented `parsedBody` contract, not a re-read of the Request stream) and
 * attaches one idempotent watcher per URI to the shared registry. The notify
 * sink publishes `resource_updated` onto the shared bus; the router narrows per
 * stream by `resourceSubscriptions`. See `attachFileWatcherForUri` for the
 * lifecycle ceiling (watchers persist for the server lifetime).
 */
async function attachListenWatchers(
  parsedBody: unknown,
  pathGuard: PathGuard,
  registry: WatcherRegistry,
  bus: InMemoryServerEventBus,
): Promise<void> {
  if (typeof parsedBody !== 'object' || parsedBody === null) return;
  const body = parsedBody as {
    method?: unknown;
    params?: { notifications?: { resourceSubscriptions?: unknown } };
  };
  if (body.method !== 'subscriptions/listen') return;
  const uris = body.params?.notifications?.resourceSubscriptions;
  if (!Array.isArray(uris)) return;
  const sink = (uri: string): void => {
    bus.publish({ kind: 'resource_updated', uri });
  };
  for (const uri of uris) {
    if (typeof uri !== 'string') continue;
    try {
      await attachFileWatcherForUri(registry, pathGuard, uri, sink);
    } catch (err: unknown) {
      // Best-effort: one bad URI must not abort the rest or the listen stream.
      Logger.warn(
        `[HTTP] listen watcher attach failed for ${uri}:`,
        formatUnknownErrorMessage(err),
      );
    }
  }
}

// Modern (2026-07-28) HTTP leg: one fresh `createServer` per request, all
// sharing a single watcher registry (so file-change interest persists across
// per-request instances) and publishing resource updates onto a shared bus
// that feeds `subscriptions/listen` streams. `legacy: 'reject'` means the
// factory is only ever called with `ctx.era === 'modern'` — legacy POSTs are
// routed away by the era-branch before they reach here.
function makeHttpModernFactory(
  options: ServerOptions,
  bus: InMemoryServerEventBus,
  sharedRegistry: WatcherRegistry,
): McpServerFactory {
  return async (_ctx) => {
    const c = await createServer(options, {
      watcherRegistry: sharedRegistry,
      notifyResourceUpdated: (uri) => {
        bus.publish({ kind: 'resource_updated', uri });
      },
    });
    c.synchronizer.markInitialized();
    // createMcpHandler only calls `mcp.close()`, never our
    // `disposeRuntimeState()` — chain it onto the low-level `onclose` so the
    // per-request registrar/watcher state is torn down. The SDK reads
    // `server.onclose` as `previousOnClose` and chains it. (legacy: 'reject'
    // guarantees every call here is the modern era, so this always runs.)
    const previousOnClose = c.mcp.server.onclose;
    c.mcp.server.onclose = () => {
      previousOnClose?.();
      c.disposeRuntimeState();
    };
    return c.mcp;
  };
}

export async function startHttpServer(port: number, options: ServerOptions): Promise<Server> {
  const httpHost = process.env['HTTP_HOST'] ?? '127.0.0.1';
  const apiKey = process.env['API_KEY'];
  assertHttpBindingPolicy(httpHost, apiKey);
  const allowedHosts = resolveAllowedHosts(httpHost, process.env['FILESYSTEM_MCP_ALLOWED_HOSTS']);
  assertHttpHostPolicy(
    httpHost,
    allowedHosts,
    process.env['FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS'] === '1',
  );

  const registry = new HttpSessionRegistry({
    handshakeTimeoutMs: getInitHandshakeTimeoutMs(),
    // Generous by default: a client that calls a tool every so often and holds
    // no stream must not lose its session between calls. Read per call, not at
    // module load, so the value is settable per server instance.
    idleTimeoutMs: parseEnvInt(
      'FILESYSTEM_MCP_SESSION_IDLE_TIMEOUT_MS',
      30 * 60_000,
      1_000,
      24 * 60 * 60_000,
    ),
  });

  // Modern leg: shared bus + shared watcher registry survive across the
  // per-request instances the factory builds. One handler serves every modern
  // POST; Express mounts it via toNodeHandler.
  const bus = new InMemoryServerEventBus();
  const sharedRegistry = createWatcherRegistry();
  // One PathGuard for the modern leg's proactive watcher attachment. Built once
  // at startup (same options as the per-request guards `createServer` builds);
  // neither hot-reloads. Cheap — `recomputeAllowedDirectories` already runs
  // per-request today.
  const watcherPathGuard = new PathGuard(options, true);
  await watcherPathGuard.recomputeAllowedDirectories();
  const modernHandler = createMcpHandler(makeHttpModernFactory(options, bus, sharedRegistry), {
    legacy: 'reject',
    bus,
    onerror: (error: Error) => {
      Logger.error('[HTTP] modern leg error:', formatUnknownErrorMessage(error));
    },
  });
  const modernNodeHandler = toNodeHandler(modernHandler);

  const app = setupExpressApp(
    httpHost,
    apiKey,
    allowedHosts,
    options,
    registry,
    modernNodeHandler,
    watcherPathGuard,
    sharedRegistry,
    bus,
  );

  const httpServer = createHttpServer(app);
  httpServer.headersTimeout = 10_000;
  // Use the standard MCP request timeout for HTTP requests
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

  registry.startSweep();

  // Tear down both legs: the 2025 sessionful stack and the modern per-request
  // handler, plus the shared watcher registry it owns.
  const originalClose = httpServer.close.bind(httpServer);
  httpServer.close = function (callback?: (error?: Error) => void) {
    sharedRegistry.destroy();
    Promise.allSettled([modernHandler.close(), registry.closeAll()])
      .then(() => {
        originalClose(callback);
      })
      .catch((err: unknown) => {
        Logger.error(
          '[HTTP] Error closing sessions during HTTP server close:',
          formatUnknownErrorMessage(err),
        );
        originalClose(callback);
      });
    return httpServer;
  };

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      sharedRegistry.destroy();
      Promise.allSettled([modernHandler.close(), registry.closeAll()]).catch(
        (closeErr: unknown) => {
          Logger.error(
            '[HTTP] Error closing sessions on startup failure:',
            formatUnknownErrorMessage(closeErr),
          );
        },
      );
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
