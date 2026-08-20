import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  DEFAULT_REQUEST_TIMEOUT_MSEC,
  type EventId,
  type EventStore,
  isInitializedNotification,
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  JSONRPC_VERSION,
  type JSONRPCMessage,
  localhostAllowedHostnames,
  parseJSONRPCMessage,
  ProtocolErrorCode,
  type RequestId,
  type StreamId,
} from '@modelcontextprotocol/server';
// Moved to a Node-only subpath export upstream (not re-exported from the
// package root, which stays platform-agnostic for non-Node runtimes).
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { randomUUID } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import type { Express, NextFunction, Request, Response } from 'express';

import { ErrorCode, formatUnknownErrorMessage, FsError } from './core/errors.js';
import { Logger, withSession } from './core/observability.js';
import type { PathGuard, ServerOptions } from './core/path.js';
import type { McpRootsSynchronizer } from './core/registrar.js';
import { getInitHandshakeTimeoutMs, INIT_TIMEOUT_CLOSE, parseEnvInt } from './core/util.js';
import {
  assertHttpBindingPolicy,
  assertHttpHostPolicy,
  bearerAuthMiddleware,
  computeAllowedOriginHostnames,
  corsPreflightHandler,
  createRateLimiter,
  isLoopbackHttpHost,
  parseAllowedHostsEnv,
  protectedResourceUrl,
} from './http-policy.js';
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
      this.streams.set(streamId, stream);
    }

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

export async function startServer(ctx: FilesystemServerContext): Promise<void> {
  const { mcp: server } = ctx;
  const transport = new StdioServerTransport();

  ctx.synchronizer.registerHandlers(
    server,
    INIT_TIMEOUT_CLOSE
      ? () => {
          server.close().catch((err: unknown) => {
            Logger.error('Error closing MCP server on timeout:', formatUnknownErrorMessage(err));
          });
        }
      : undefined,
  );
  await ctx.pathGuard.recomputeAllowedDirectories();

  transport.onerror = (error: unknown) => {
    Logger.error('[Stdio] Transport error:', formatUnknownErrorMessage(error));
  };

  try {
    await server.connect(transport);
  } catch (error) {
    ctx.disposeRuntimeState();
    throw error;
  }

  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    ctx.disposeRuntimeState();
    sdkOnClose?.();
  };

  ctx.synchronizer.logMissingDirectoriesIfNeeded();
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

function buildJsonRpcError(
  code: number,
  message: string,
  id: RequestId | null = null,
): PreDispatchJsonRpcError {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message },
  };
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  id: RequestId | null = null,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(buildJsonRpcError(code, message, id)));
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
  server: McpServer;
  pathGuard: PathGuard;
  synchronizer?: McpRootsSynchronizer;
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
  sweepIntervalMs?: number;
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
    this.sweepIntervalMs = opts.sweepIntervalMs ?? opts.handshakeTimeoutMs * 2;
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
    const isSessionInitialized = session.synchronizer
      ? session.synchronizer.isInitialized()
      : session.pathGuard.isInitialized();

    if (!isSessionInitialized) {
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

  async closeAll(): Promise<void> {
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

  let currentSessionId: string | undefined;

  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => {
      currentSessionId = randomUUID();
      return currentSessionId;
    },
    eventStore,
    retryInterval: 2_000,
    onsessioninitialized: (sessionId) => {
      currentSessionId = sessionId;
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
    server: mcpServer,
    pathGuard,
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
  options: ServerOptions,
  registry: HttpSessionRegistry,
): Express {
  const configuredHosts = parseAllowedHostsEnv(process.env['FILESYSTEM_MCP_ALLOWED_HOSTS']);

  // A loopback bind gets the whole localhost hostname set, not just the bind
  // address: a client dialing http://localhost:<port> sends `Host: localhost`,
  // which a bare ['127.0.0.1'] list would 403.
  const allowedHosts =
    configuredHosts.length > 0
      ? configuredHosts
      : isLoopbackHttpHost(httpHost)
        ? localhostAllowedHostnames()
        : httpHost === '0.0.0.0' || httpHost === '::'
          ? []
          : [httpHost];

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
      const resource = protectedResourceUrl(req);
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
    app.get('/.well-known/oauth-protected-resource/mcp', metadataHandler);
  }

  app.use('/mcp', bearerAuthMiddleware(apiKey));

  app.post('/mcp', (req: Request, res: Response, next: NextFunction) => {
    handlePostMcp(req, res, options, registry).catch(next);
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

export async function startHttpServer(port: number, options: ServerOptions): Promise<Server> {
  const httpHost = process.env['HTTP_HOST'] ?? '127.0.0.1';
  const apiKey = process.env['API_KEY'];
  assertHttpBindingPolicy(httpHost, apiKey);
  assertHttpHostPolicy(
    httpHost,
    process.env['FILESYSTEM_MCP_ALLOWED_HOSTS'],
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

  const app = setupExpressApp(httpHost, apiKey, options, registry);

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

  const originalClose = httpServer.close.bind(httpServer);
  httpServer.close = function (callback?: (error?: Error) => void) {
    registry
      .closeAll()
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
      registry.closeAll().catch((closeErr: unknown) => {
        Logger.error(
          '[HTTP] Error closing sessions on startup failure:',
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
