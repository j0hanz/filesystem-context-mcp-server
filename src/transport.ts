import {
  createMcpExpressApp,
  hostHeaderValidation,
  localhostHostValidation,
} from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  DEFAULT_REQUEST_TIMEOUT_MSEC,
  type EventId,
  type EventStore,
  isInitializedNotification,
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  JSONRPC_VERSION,
  type JSONRPCErrorResponse,
  type JSONRPCMessage,
  parseJSONRPCMessage,
  ProtocolErrorCode,
  type StreamId,
} from '@modelcontextprotocol/server';
// Moved to a Node-only subpath export upstream (not re-exported from the
// package root, which stays platform-agnostic for non-Node runtimes).
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';

import { ErrorCode, formatUnknownErrorMessage, FsError } from './core/errors.js';
import { Logger, withSession, withTelemetry } from './core/observability.js';
import type { PathGuard, ServerOptions } from './core/path.js';
import type { McpRootsSynchronizer } from './core/registrar.js';
import { getInitHandshakeTimeoutMs, INIT_TIMEOUT_CLOSE, parseEnvInt } from './core/util.js';
import type { FilesystemServerContext } from './server.js';
import { createServer } from './server.js';

// ═══════════════════════════════════════════════════════════════
// event-store
// ═══════════════════════════════════════════════════════════════

const MAX_EVENTS_PER_STREAM = 1000;

interface StoredEvent {
  readonly id: EventId;
  readonly message: JSONRPCMessage;
}

/**
 * Bounded in-memory ring buffer supporting resumable streams (`Last-Event-ID`).
 * Each stream keeps at most `MAX_EVENTS_PER_STREAM` events (FIFO eviction);
 * events are lost across process restarts and once evicted, matching the
 * "best-effort" resumability contract of the streamable HTTP transport.
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

  delete(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    for (const event of stream) {
      this.eventIdToStreamId.delete(event.id);
    }
    this.streams.delete(streamId);
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
const MAX_BEARER_TOKEN_LENGTH = 4096;

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

const ALLOWED_ORIGIN_PATTERNS: readonly RegExp[] = [
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u,
];

/**
 * Builds a JSON-RPC error response object with the given code and message.
 * The `id` field is set to `null` since this is a response to an invalid request that may not have a valid ID.
 */
function buildJsonRpcError(code: number, message: string): JSONRPCErrorResponse {
  const payload: Omit<JSONRPCErrorResponse, 'id'> & { id: null } = {
    jsonrpc: JSONRPC_VERSION,
    id: null,
    error: { code, message },
  };
  return payload as unknown as JSONRPCErrorResponse;
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(buildJsonRpcError(code, message)));
}

function getSessionId(req: IncomingMessage): string | undefined {
  const rawSessionId = req.headers['mcp-session-id'];
  if (typeof rawSessionId !== 'string' || !isValidSessionId(rawSessionId)) return undefined;
  return rawSessionId;
}

type JsonRpcKind = 'request' | 'notification' | 'result' | 'error' | 'unknown';

function classifyJsonRpcMessage(message: JSONRPCMessage): JsonRpcKind {
  if (isJSONRPCRequest(message)) return 'request';
  if (isJSONRPCNotification(message)) return 'notification';
  if (isJSONRPCResultResponse(message)) return 'result';
  if (isJSONRPCErrorResponse(message)) return 'error';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// HttpAuthGuard — pure auth + binding policy
// ---------------------------------------------------------------------------

/**
 * Pure HTTP auth and binding policy. Holds no state; all functions are
 * directly testable without spinning up a server.
 */
export function isLoopbackHttpHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return (
    normalizedHost === '127.0.0.1' || normalizedHost === 'localhost' || normalizedHost === '[::1]'
  );
}

export function isAllowedLocalhostOrigin(origin: string): boolean {
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

function originHostname(origin: string): string | undefined {
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
}

/**
 * True if `origin` (a raw `Origin` request header) is allowed given the
 * env-derived `allowedHostnames` set (hostname-form, no scheme/port). Localhost
 * origins are always accepted via {@link isAllowedLocalhostOrigin}; a remote
 * origin is accepted iff its parsed hostname is in the set. Both the SDK app's
 * `allowedOrigins` and this OPTIONS-handler check consume hostname-form, so a
 * remote origin allowed via `FILESYSTEM_MCP_ALLOWED_ORIGINS` is reflected
 * end-to-end in `Access-Control-Allow-Origin`.
 */
export function isOriginAllowed(origin: string, allowedHostnames: readonly string[]): boolean {
  if (isAllowedLocalhostOrigin(origin)) return true;
  const host = originHostname(origin);
  return host !== undefined && allowedHostnames.includes(host);
}

export function validateBearerAuthorization(apiKey: string, authHeader: unknown): boolean {
  const bearerPrefix = 'Bearer ';
  if (typeof authHeader !== 'string' || !authHeader.startsWith(bearerPrefix)) {
    return false;
  }
  const userKey = authHeader.slice(bearerPrefix.length);
  if (userKey.length > MAX_BEARER_TOKEN_LENGTH) {
    return false;
  }

  // Pure: hash per call. createHash is negligible next to the timingSafeEqual
  // already done per request, and avoiding module-level cache state keeps this
  // testable without post-import env-mutation footguns.
  const expectedHash = createHash('sha256').update(apiKey).digest();
  const actualHash = createHash('sha256').update(userKey).digest();
  return timingSafeEqual(expectedHash, actualHash);
}

function isSecureApiKey(key: string | undefined): boolean {
  return typeof key === 'string' && key.trim().length >= 16;
}

/**
 * Refuse to bind to a non-loopback host without an API key. Throws on
 * policy violation; returns silently when allowed.
 */
export function assertHttpBindingPolicy(host: string, apiKey: string | undefined): void {
  if (isLoopbackHttpHost(host)) {
    if (apiKey !== undefined && !isSecureApiKey(apiKey)) {
      throw new FsError(
        ErrorCode.PERMISSION_DENIED,
        'API_KEY is configured but is insecure (minimum 16 characters).',
      );
    }
    return;
  }
  if (isSecureApiKey(apiKey)) return;
  throw new FsError(
    ErrorCode.PERMISSION_DENIED,
    `Refusing to bind HTTP server to non-loopback host '${host}' without a secure API_KEY (minimum 16 characters).`,
  );
}

/**
 * Refuse to bind a wildcard host (`0.0.0.0` / `::`) without an explicit
 * `FILESYSTEM_MCP_ALLOWED_HOSTS` list. Clients never send `Host: 0.0.0.0`, so
 * defaulting the allowed-host set to the wildcard string would reject all real
 * traffic. Operators who accept the risk can set
 * `FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS=1` to restore warn-and-bind.
 * Loopback and concrete non-loopback hosts are unaffected.
 */
export function assertHttpHostPolicy(
  host: string,
  allowedHostsEnv: string | undefined,
  allowUnrestricted: boolean,
): void {
  if (isLoopbackHttpHost(host)) return;
  const isWildcard = host === '0.0.0.0' || host === '::';
  if (!isWildcard) return; // concrete non-loopback: Host validated against the bind host.
  if (allowUnrestricted) return;
  if (allowedHostsEnv !== undefined && allowedHostsEnv.trim().length > 0) return;
  throw new FsError(
    ErrorCode.PERMISSION_DENIED,
    `Refusing to bind wildcard host '${host}' without FILESYSTEM_MCP_ALLOWED_HOSTS. Set it to the public hostname(s) clients send, or set FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS=1 to accept the risk.`,
  );
}

/**
 * Express middleware: when `apiKey` is set, require a matching bearer token.
 * No key set = open access (loopback dev mode). `apiKey` is captured once per
 * app setup (passed in from startHttpServer) so the middleware and
 * assertHttpBindingPolicy share one source of truth.
 */
function bearerAuthMiddleware(apiKey: string | undefined): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!apiKey) {
      next();
      return;
    }
    if (isSecureApiKey(apiKey) && validateBearerAuthorization(apiKey, req.headers.authorization)) {
      next();
      return;
    }
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer',
    });
    // -32000 is the JSON-RPC server-defined error range; no SDK enum maps to "Unauthorized".
    res.end(JSON.stringify(buildJsonRpcError(-32000, 'Unauthorized')));
  };
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
  close: () => Promise<void>;
}

interface HttpSessionRegistryOptions {
  eventStore: InMemoryEventStore;

  handshakeTimeoutMs: number;
  sweepIntervalMs?: number;
}

/**
 * Single source of truth for the live HTTP session set. Replaces the previous
 * pair of parallel maps (`sessions` + `activeServers`) and the inline sweep
 * timer in `startHttpServer`. HTTP-specific by design — stdio has no sessions.
 */
class HttpSessionRegistry {
  private readonly sessions = new Map<string, HttpSession>();
  private readonly eventStore: InMemoryEventStore;

  private readonly handshakeTimeoutMs: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(opts: HttpSessionRegistryOptions) {
    this.eventStore = opts.eventStore;

    this.handshakeTimeoutMs = opts.handshakeTimeoutMs;
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

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.eventStore.delete(sessionId);
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

  private sweepStale(): void {
    const now = Date.now();
    const staleSessionIds: string[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (this.closingSessionIds.has(sessionId)) continue;
      const isSessionInitialized = session.synchronizer
        ? session.synchronizer.isInitialized()
        : session.pathGuard.isInitialized();
      if (!isSessionInitialized && now - session.createdAt > this.handshakeTimeoutMs) {
        staleSessionIds.push(sessionId);
      }
    }

    for (const sessionId of staleSessionIds) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      Logger.warn(`[HTTP] Evicting stale session ${sessionId}`);
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
    this.eventStore.clear();
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
  eventStore: InMemoryEventStore,
): Promise<HttpSession> {
  const serverCtx = await createServer(options);
  const mcpServer = serverCtx.mcp;
  const pathGuard = serverCtx.pathGuard;
  const synchronizer = serverCtx.synchronizer;

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    serverCtx.disposeRuntimeState();
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
      const loggingState = pathGuard.loggingState;
      if (!loggingState) {
        throw new FsError(ErrorCode.VALIDATION_FAILED, 'LoggingState is required');
      }
      registry.add(sessionId, {
        server: mcpServer,
        pathGuard,
        synchronizer,
        transport,
        createdAt: Date.now(),
        close,
      });
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

  return {
    server: mcpServer,
    pathGuard,
    synchronizer,
    transport,
    createdAt: Date.now(),
    close,
  };
}

async function handleSessionTransportRequest(
  session: HttpSession,
  req: IncomingMessage,
  res: ServerResponse,
  body?: unknown,
): Promise<void> {
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
  eventStore: InMemoryEventStore,
): Promise<void> {
  const method = req.method;
  const path = req.originalUrl;
  const sessionId = getSessionId(req);

  return withTelemetry(
    {
      event: 'http_request_complete',
      transport: 'http',
      method,
      path,
      ...(sessionId ? { session_id: sessionId } : {}),
    },
    async (enrich: (extraData: Record<string, unknown>) => void) => {
      let jsonrpcMethod: string | undefined;

      try {
        const body = req.body as unknown;
        let message: JSONRPCMessage;
        try {
          message = parseJSONRPCMessage(body);
        } catch {
          // Invalid JSON-RPC shape
          sendJsonRpcError(res, 400, ProtocolErrorCode.InvalidRequest, 'Invalid Request');
          enrich({ http_status: 400, outcome: 'rejected', request_kind: 'unknown' });
          return;
        }

        const kind = classifyJsonRpcMessage(message);
        jsonrpcMethod =
          'method' in message && typeof message.method === 'string' ? message.method : undefined;

        enrich({
          request_kind: kind,
          ...(jsonrpcMethod ? { jsonrpc_method: jsonrpcMethod } : {}),
        });

        Logger.debug('[HTTP] inbound', { kind, sessionId: sessionId ?? null });
        if (isInitializedNotification(message)) {
          Logger.debug('[HTTP] initialized notification received', {
            sessionId: sessionId ?? null,
          });
        }

        if (sessionId) {
          const session = registry.getOrRespondNotFound(sessionId, res);
          if (session) {
            await handleSessionTransportRequest(session, req, res, message);
            enrich({ http_status: res.statusCode });
          } else {
            enrich({ http_status: res.statusCode, outcome: 'rejected' });
          }
          return;
        }

        // No session yet — only an initialize request may open one.
        if (kind === 'result' || kind === 'error') {
          sendJsonRpcError(
            res,
            400,
            ProtocolErrorCode.InvalidRequest,
            'JSON-RPC response or notification cannot start a new session',
          );
          enrich({ http_status: 400, outcome: 'rejected' });
          return;
        }

        if (!isInitializeRequest(message)) {
          sendJsonRpcError(
            res,
            400,
            ProtocolErrorCode.InvalidRequest,
            'Bad Request: No valid session ID provided',
          );
          enrich({ http_status: 400, outcome: 'rejected' });
          return;
        }
        const maxSessions = parseEnvInt('FILESYSTEM_MCP_MAX_HTTP_SESSIONS', 100, 1, 10_000);
        if (registry.size() >= maxSessions) {
          sendJsonRpcError(res, 503, ProtocolErrorCode.InternalError, 'Too many sessions');
          enrich({ http_status: 503, outcome: 'rejected' });
          return;
        }
        const session = await createHttpSession(options, registry, eventStore);
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
        enrich({ http_status: res.statusCode });
      } catch (error) {
        Logger.error('[HTTP] Error handling POST request:', formatUnknownErrorMessage(error));
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, ProtocolErrorCode.InternalError, 'Internal Server Error');
        }
        // Do NOT rethrow — an unhandled rejection here would trigger a process-wide shutdown.
        // The error is already logged, and we've sent a 500 response if possible.
        enrich({ http_status: res.statusCode, outcome: 'error' });
      }
    },
  );
}

async function handleGetOrDeleteMcp(
  req: Request,
  res: Response,
  registry: HttpSessionRegistry,
): Promise<void> {
  const method = req.method;
  const path = req.originalUrl;
  const sessionId = getSessionId(req);

  return withTelemetry(
    {
      event: 'http_request_complete',
      transport: 'http',
      method,
      path,
      request_kind: 'unknown',
      ...(sessionId ? { session_id: sessionId } : {}),
    },
    async (enrich: (extraData: Record<string, unknown>) => void) => {
      try {
        if (!sessionId) {
          sendJsonRpcError(
            res,
            400,
            ProtocolErrorCode.InvalidRequest,
            'Bad Request: Missing session ID',
          );
          enrich({ http_status: 400, outcome: 'rejected' });
          return;
        }
        const session = registry.getOrRespondNotFound(sessionId, res);
        if (session) {
          await handleSessionTransportRequest(session, req, res);
          enrich({ http_status: res.statusCode });
        } else {
          enrich({ http_status: res.statusCode, outcome: 'rejected' });
        }
      } catch (error) {
        Logger.error(
          `[HTTP] Error handling ${req.method} request:`,
          formatUnknownErrorMessage(error),
        );
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, ProtocolErrorCode.InternalError, 'Internal Server Error');
        }
        // Do NOT rethrow — an unhandled rejection here would trigger a process-wide shutdown.
        enrich({ http_status: res.statusCode, outcome: 'error' });
      }
    },
  );
}

function setupExpressApp(
  httpHost: string,
  apiKey: string | undefined,
  options: ServerOptions,
  registry: HttpSessionRegistry,
  eventStore: InMemoryEventStore,
): Express {
  const allowedHostsEnv = process.env['FILESYSTEM_MCP_ALLOWED_HOSTS'];
  const allowedHosts = allowedHostsEnv
    ? allowedHostsEnv.split(',').map((h) => h.trim())
    : httpHost === '0.0.0.0' || httpHost === '::'
      ? []
      : [httpHost];

  // Env-derived CORS origins (hostname-form, no scheme/port — matches the SDK
  // app's allowedOrigins consumer). Default to the localhost set so loopback
  // browser clients keep working; operators set FILESYSTEM_MCP_ALLOWED_ORIGINS
  // to allow remote clients on non-loopback binds. The same set is consulted by
  // the OPTIONS preflight handler below so a remote origin is reflected
  // end-to-end in Access-Control-Allow-Origin.
  const allowedOriginHostnames = (
    process.env['FILESYSTEM_MCP_ALLOWED_ORIGINS'] ?? 'localhost,127.0.0.1'
  )
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const app = createMcpExpressApp({
    host: httpHost,
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    // Origin validation is enforced by the SDK app itself (not left to its
    // localhost-bind-only default) so non-loopback binds are covered too —
    // matches the hostnames isOriginAllowed() reflects for CORS below.
    ...(allowedOriginHostnames.length > 0 ? { allowedOrigins: allowedOriginHostnames } : {}),
    jsonLimit: `${MAX_REQUEST_BODY_BYTES}b`,
  });

  if (allowedHostsEnv) {
    app.use('/mcp', hostHeaderValidation(allowedHosts));
  } else if (isLoopbackHttpHost(httpHost)) {
    app.use('/mcp', localhostHostValidation());
  } else if (allowedHosts.length > 0) {
    app.use('/mcp', hostHeaderValidation(allowedHosts));
  } else {
    // Reachable only under FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS=1 —
    // assertHttpHostPolicy throws for a wildcard bind without allowed hosts.
    Logger.warn(
      '[HTTP] FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS is set: binding globally without Host validation.',
    );
  }

  app.options('/mcp', (req: Request, res: Response) => {
    // Reflect a present Origin if it is allowed — localhost, or in the
    // env-derived FILESYSTEM_MCP_ALLOWED_ORIGINS set. Avoid emitting a wildcard fallback.
    const origin = req.headers.origin;
    if (origin && isOriginAllowed(origin, allowedOriginHostnames)) {
      res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, mcp-session-id, mcp-protocol-version',
    );
    res.status(204).end();
  });

  app.use('/mcp', bearerAuthMiddleware(apiKey));

  app.post('/mcp', (req: Request, res: Response, next: NextFunction) => {
    handlePostMcp(req, res, options, registry, eventStore).catch(next);
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

  return app;
}

export async function startHttpServer(port: number, options: ServerOptions): Promise<Server> {
  const eventStore = new InMemoryEventStore();
  const httpHost = process.env['HTTP_HOST'] ?? '127.0.0.1';
  const apiKey = process.env['API_KEY'];
  assertHttpBindingPolicy(httpHost, apiKey);
  assertHttpHostPolicy(
    httpHost,
    process.env['FILESYSTEM_MCP_ALLOWED_HOSTS'],
    process.env['FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS'] === '1',
  );

  const registry = new HttpSessionRegistry({
    eventStore,

    handshakeTimeoutMs: getInitHandshakeTimeoutMs(),
  });

  const app = setupExpressApp(httpHost, apiKey, options, registry, eventStore);

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
