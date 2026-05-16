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
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  JSONRPC_VERSION,
  type JSONRPCErrorResponse,
  type JSONRPCMessage,
  localhostAllowedHostnames,
  parseJSONRPCMessage,
  ProtocolErrorCode,
  StdioServerTransport,
  type StreamId,
  validateHostHeader,
} from '@modelcontextprotocol/server';

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';

import { formatUnknownErrorMessage } from './core/errors.js';
import {
  Logger,
  type LogRouter,
  type LogTarget,
  SessionContext,
  withTelemetry,
} from './core/observability.js';
import type { PathGuard, ServerOptions } from './core/path.js';
import { getInitHandshakeTimeoutMs, INIT_TIMEOUT_CLOSE, parseEnvInt } from './core/util.js';
import type { FilesystemServerContext } from './server.js';
import { createServer, logRouter } from './server.js';

// ═══════════════════════════════════════════════════════════════
// event-store
// ═══════════════════════════════════════════════════════════════

const MAX_EVENTS_PER_STREAM = 1000;

interface StoredEvent {
  id: EventId;
  message: JSONRPCMessage;
}

export class InMemoryEventStore implements EventStore {
  // Map of streamId -> StoredEvent[]
  private streams = new Map<StreamId, StoredEvent[]>();
  // Map of eventId -> streamId for fast lookup
  private eventIdToStreamId = new Map<EventId, StreamId>();

  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = randomUUID();
    let stream = this.streams.get(streamId);

    if (!stream) {
      stream = [];
      this.streams.set(streamId, stream);
    }

    // Add new event
    stream.push({ id: eventId, message });
    this.eventIdToStreamId.set(eventId, streamId);

    // Enforce limits
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
      throw new Error(`Event ID ${lastEventId} not found or expired`);
    }

    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new Error(`Stream ${streamId} not found`);
    }

    const eventIndex = stream.findIndex((e) => e.id === lastEventId);
    if (eventIndex === -1) {
      throw new Error(`Event ID ${lastEventId} not found in stream ${streamId}`);
    }

    // Replay all events after the found index
    for (let i = eventIndex + 1; i < stream.length; i++) {
      const event = stream[i];
      if (event) {
        await callbacks.send(event.id, event.message);
      }
    }

    return streamId;
  }

  /**
   * Cleans up all events for a given streamId.
   */
  delete(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (stream) {
      for (const event of stream) {
        this.eventIdToStreamId.delete(event.id);
      }
      this.streams.delete(streamId);
    }
  }

  /**
   * Cleans up all streams.
   */
  clear(): void {
    this.streams.clear();
    this.eventIdToStreamId.clear();
  }
}

export async function startServer(ctx: FilesystemServerContext): Promise<void> {
  const { mcp: server } = ctx;
  const transport = new StdioServerTransport();

  ctx.pathGuard.registerHandlers(
    server,
    INIT_TIMEOUT_CLOSE
      ? () => {
          void server.close();
        }
      : undefined,
  );
  await ctx.pathGuard.recomputeAllowedDirectories();
  await server.connect(transport);
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    ctx.disposeRuntimeState();
    sdkOnClose?.();
  };

  ctx.pathGuard.logMissingDirectoriesIfNeeded(server);
}

const MAX_SESSION_ID_LENGTH = 256;
const MAX_BEARER_TOKEN_LENGTH = 4096;
const JSON_RPC_SERVER_ERROR = -32000;
const JSON_RPC_INVALID_REQUEST = ProtocolErrorCode.InvalidRequest;
const JSON_RPC_PARSE_ERROR = ProtocolErrorCode.ParseError;
const JSON_RPC_INTERNAL_ERROR = ProtocolErrorCode.InternalError;

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
  return typeof rawSessionId === 'string' && rawSessionId.length <= MAX_SESSION_ID_LENGTH
    ? rawSessionId
    : undefined;
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
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

export function isAllowedLocalhostOrigin(origin: string): boolean {
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

let cachedApiKey: string | undefined;
let cachedExpectedHash: Buffer | undefined;

export function validateBearerAuthorization(apiKey: string, authHeader: unknown): boolean {
  const bearerPrefix = 'Bearer ';
  if (typeof authHeader !== 'string' || !authHeader.startsWith(bearerPrefix)) {
    return false;
  }
  const userKey = authHeader.slice(bearerPrefix.length);
  if (userKey.length > MAX_BEARER_TOKEN_LENGTH) {
    return false;
  }

  let expectedHash: Buffer;
  if (apiKey === cachedApiKey && cachedExpectedHash !== undefined) {
    expectedHash = cachedExpectedHash;
  } else {
    expectedHash = createHash('sha256').update(apiKey).digest();
    cachedApiKey = apiKey;
    cachedExpectedHash = expectedHash;
  }

  const actualHash = createHash('sha256').update(userKey).digest();
  return timingSafeEqual(expectedHash, actualHash);
}

/**
 * Refuse to bind to a non-loopback host without an API key. Throws on
 * policy violation; returns silently when allowed.
 */
export function assertHttpBindingPolicy(host: string, apiKey: string | undefined): void {
  if (isLoopbackHttpHost(host)) return;
  if (apiKey) return;
  throw new Error(
    `Refusing to bind HTTP server to non-loopback host '${host}' without FILESYSTEM_MCP_API_KEY.`,
  );
}

/** Express middleware: reject browser origins outside localhost. */
function originGuardMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.get('origin');
    if (origin && !isAllowedLocalhostOrigin(origin)) {
      res.status(403).send('Forbidden: disallowed origin');
      return;
    }
    next();
  };
}

/**
 * Express middleware: when `FILESYSTEM_MCP_API_KEY` is set, require a
 * matching bearer token. No key set = open access (loopback dev mode).
 */
function bearerAuthMiddleware(): RequestHandler {
  const apiKey = process.env['FILESYSTEM_MCP_API_KEY'];
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!apiKey) {
      next();
      return;
    }
    if (validateBearerAuthorization(apiKey, req.headers.authorization)) {
      next();
      return;
    }
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer',
    });
    res.end(JSON.stringify(buildJsonRpcError(JSON_RPC_SERVER_ERROR, 'Unauthorized')));
  };
}

// ---------------------------------------------------------------------------
// HttpSessionRegistry — owns session map, sweep timer, log-router wiring
// ---------------------------------------------------------------------------

export interface HttpSession {
  server: McpServer;
  pathGuard: PathGuard;
  transport: NodeStreamableHTTPServerTransport;
  createdAt: number;
  close: () => Promise<void>;
}

interface HttpSessionRegistryOptions {
  eventStore: InMemoryEventStore;
  logRouter: LogRouter;
  handshakeTimeoutMs: number;
  sweepIntervalMs?: number;
}

/**
 * Single source of truth for the live HTTP session set. Replaces the previous
 * pair of parallel maps (`sessions` + `activeServers`) and the inline sweep
 * timer in `startHttpServer`. HTTP-specific by design — stdio has no sessions.
 */
export class HttpSessionRegistry {
  private readonly sessions = new Map<string, HttpSession>();
  private readonly eventStore: InMemoryEventStore;
  private readonly logRouter: LogRouter;
  private readonly handshakeTimeoutMs: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(opts: HttpSessionRegistryOptions) {
    this.eventStore = opts.eventStore;
    this.logRouter = opts.logRouter;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? opts.handshakeTimeoutMs * 2;
  }

  size(): number {
    return this.sessions.size;
  }

  get(sessionId: string): HttpSession | undefined {
    return this.sessions.get(sessionId);
  }

  add(sessionId: string, session: HttpSession, logTarget: LogTarget): void {
    this.sessions.set(sessionId, session);
    this.logRouter.attachSession(sessionId, logTarget);
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.logRouter.detachSession(sessionId);
    this.eventStore.delete(sessionId);
  }

  getOrRespondNotFound(sessionId: string, res: ServerResponse): HttpSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      sendJsonRpcError(res, 404, JSON_RPC_SERVER_ERROR, 'Session not found');
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

  private sweepStale(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (!session.pathGuard.isInitialized() && now - session.createdAt > this.handshakeTimeoutMs) {
        Logger.warn(`[HTTP] Evicting stale session ${sessionId}`);
        session.close().catch((err: unknown) => {
          Logger.error(
            `[HTTP] Error closing stale session ${sessionId}:`,
            formatUnknownErrorMessage(err),
          );
          this.eventStore.delete(sessionId);
        });
      }
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

  pathGuard.registerHandlers(mcpServer, () => {
    cleanup();
    void mcpServer.close();
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
      const loggingState = pathGuard.loggingState;
      if (!loggingState) throw new Error('LoggingState is required');
      registry.add(
        sessionId,
        {
          server: mcpServer,
          pathGuard,
          transport,
          createdAt: Date.now(),
          close,
        },
        { server: mcpServer, loggingState },
      );
      pathGuard.logMissingDirectoriesIfNeeded(mcpServer);
    },
    onsessionclosed: async (sessionId) => {
      const session = registry.get(sessionId);
      if (session) {
        await session.close();
      }
    },
  });

  transport.onclose = cleanup;

  await mcpServer.connect(transport);

  return {
    server: mcpServer,
    pathGuard,
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
  const store = session.transport.sessionId ? { sessionId: session.transport.sessionId } : {};
  await SessionContext.run(store, async () => {
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
    sendJsonRpcError(res, 413, JSON_RPC_INVALID_REQUEST, 'Request body too large');
    return;
  }
  if (err.status === 400) {
    sendJsonRpcError(res, 400, JSON_RPC_PARSE_ERROR, 'Invalid JSON in request body');
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
    async (enrich) => {
      let jsonrpcMethod: string | undefined;

      try {
        const body = req.body as unknown;
        let message: JSONRPCMessage;
        try {
          message = parseJSONRPCMessage(body);
        } catch {
          // Invalid JSON-RPC shape
          sendJsonRpcError(res, 400, JSON_RPC_INVALID_REQUEST, 'Invalid Request');
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
            JSON_RPC_INVALID_REQUEST,
            'JSON-RPC response or notification cannot start a new session',
          );
          enrich({ http_status: 400, outcome: 'rejected' });
          return;
        }

        if (!isInitializeRequest(message)) {
          sendJsonRpcError(
            res,
            400,
            JSON_RPC_SERVER_ERROR,
            'Bad Request: No valid session ID provided',
          );
          enrich({ http_status: 400, outcome: 'rejected' });
          return;
        }
        const maxSessions = parseEnvInt('FILESYSTEM_MCP_MAX_HTTP_SESSIONS', 100, 1, 10_000);
        if (registry.size() >= maxSessions) {
          sendJsonRpcError(res, 503, JSON_RPC_SERVER_ERROR, 'Too many sessions');
          enrich({ http_status: 503, outcome: 'rejected' });
          return;
        }
        const session = await createHttpSession(options, registry, eventStore);
        await handleSessionTransportRequest(session, req, res, message);
        enrich({ http_status: res.statusCode });
      } catch (error) {
        Logger.error('[HTTP] Error handling POST request:', formatUnknownErrorMessage(error));
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, JSON_RPC_INTERNAL_ERROR, 'Internal Server Error');
        }
        enrich({ http_status: res.statusCode });
        throw error;
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
    async (enrich) => {
      try {
        if (!sessionId) {
          sendJsonRpcError(res, 400, JSON_RPC_SERVER_ERROR, 'Bad Request: Missing session ID');
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
          sendJsonRpcError(res, 500, JSON_RPC_INTERNAL_ERROR, 'Internal Server Error');
        }
        enrich({ http_status: res.statusCode });
        throw error;
      }
    },
  );
}

function setupExpressApp(
  httpHost: string,
  options: ServerOptions,
  registry: HttpSessionRegistry,
  eventStore: InMemoryEventStore,
): Express {
  const app = createMcpExpressApp({
    host: httpHost,
    ...(!isLoopbackHttpHost(httpHost) ? { allowedHosts: [httpHost] } : {}),
    jsonLimit: `${MAX_REQUEST_BODY_BYTES}b`,
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host;
    const allowedHosts = [...localhostAllowedHostnames(), httpHost];
    const result = validateHostHeader(host, allowedHosts);
    if (!result.ok) {
      res.status(403).json({ error: 'Invalid Host header' });
      return;
    }
    next();
  });

  app.use(originGuardMiddleware());

  app.options('/mcp', (req: Request, res: Response) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, mcp-session-id, mcp-protocol-version',
    );
    res.status(204).end();
  });

  app.use('/mcp', bearerAuthMiddleware());

  app.use(errorHandlerMiddleware);

  app.post('/mcp', (req: Request, res: Response) => {
    void handlePostMcp(req, res, options, registry, eventStore);
  });

  const getOrDeleteHandler = (req: Request, res: Response) => {
    void handleGetOrDeleteMcp(req, res, registry);
  };

  app.get('/mcp', getOrDeleteHandler);
  app.delete('/mcp', getOrDeleteHandler);

  app.all('/mcp', (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'GET, POST, DELETE, OPTIONS').end();
  });

  return app;
}

export async function startHttpServer(port: number, options: ServerOptions): Promise<Server> {
  const eventStore = new InMemoryEventStore();
  const httpHost = process.env['FILESYSTEM_MCP_HTTP_HOST'] ?? '127.0.0.1';
  assertHttpBindingPolicy(httpHost, process.env['FILESYSTEM_MCP_API_KEY']);

  const registry = new HttpSessionRegistry({
    eventStore,
    logRouter,
    handshakeTimeoutMs: getInitHandshakeTimeoutMs(),
  });

  const app = setupExpressApp(httpHost, options, registry, eventStore);

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

  httpServer.once('close', () => {
    void registry.closeAll();
  });

  const originalClose = httpServer.close.bind(httpServer);
  httpServer.close = function (callback?: (error?: Error) => void) {
    void registry.closeAll();
    return originalClose(callback);
  };

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
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
