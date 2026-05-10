import { hostHeaderValidation, localhostHostValidation } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  isInitializeRequest,
  type JSONRPCMessage,
  ProtocolErrorCode,
  StdioServerTransport,
} from '@modelcontextprotocol/server';

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { formatUnknownErrorMessage } from './core/errors.js';
import type { LogRouter } from './core/observability.js';
import { Logger, type LogTarget, SessionContext } from './core/observability.js';
import { getInitHandshakeTimeoutMs, INIT_TIMEOUT_CLOSE, parseEnvInt } from './core/util.js';
import type { FilesystemServerContext } from './server.js';
import { createServer, logRouter, type RootsManager, type ServerOptions } from './server.js';

// ═══════════════════════════════════════════════════════════════
// event-store
// ═══════════════════════════════════════════════════════════════

const MAX_EVENTS_PER_STREAM = 1000;

interface StoredEvent {
  id: string;
  message: JSONRPCMessage;
}

export class InMemoryEventStore {
  // Map of streamId -> StoredEvent[]
  private streams = new Map<string, StoredEvent[]>();
  // Map of eventId -> streamId for fast lookup
  private eventIdToStreamId = new Map<string, string>();

  storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
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

  getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    return Promise.resolve(this.eventIdToStreamId.get(eventId));
  }

  async replayEventsAfter(
    lastEventId: string,
    callbacks: {
      send: (eventId: string, message: JSONRPCMessage) => Promise<void>;
    },
  ): Promise<string> {
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

  ctx.roots.registerHandlers(
    server,
    INIT_TIMEOUT_CLOSE
      ? () => {
          void server.close();
        }
      : undefined,
  );
  await ctx.roots.recomputeAllowedDirectories();
  await server.connect(transport);
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    ctx.resourcesHandle.destroy();
    ctx.roots.destroy();
    logRouter.detachStdio();
    sdkOnClose?.();
  };

  ctx.roots.logMissingDirectoriesIfNeeded(server);
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

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    }),
  );
}

function getSessionId(req: IncomingMessage): string | undefined {
  const rawSessionId = req.headers['mcp-session-id'];
  return typeof rawSessionId === 'string' && rawSessionId.length <= MAX_SESSION_ID_LENGTH
    ? rawSessionId
    : undefined;
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
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: JSON_RPC_SERVER_ERROR, message: 'Unauthorized' },
        id: null,
      }),
    );
  };
}

// ---------------------------------------------------------------------------
// HttpSessionRegistry — owns session map, sweep timer, log-router wiring
// ---------------------------------------------------------------------------

export interface HttpSession {
  server: McpServer;
  rootsManager: RootsManager;
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
      if (
        !session.rootsManager.isInitialized() &&
        now - session.createdAt > this.handshakeTimeoutMs
      ) {
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
  const rootsManager = serverCtx.roots;

  rootsManager.registerHandlers(mcpServer);
  await rootsManager.recomputeAllowedDirectories();

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    serverCtx.resourcesHandle.destroy();
    const { sessionId } = transport;
    if (sessionId) {
      registry.remove(sessionId);
    }
    rootsManager.destroy();
  };

  const close = async (): Promise<void> => {
    cleanup();
    await mcpServer.close();
  };

  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    eventStore,
    retryInterval: 2_000,
    onsessioninitialized: (sessionId) => {
      registry.add(
        sessionId,
        {
          server: mcpServer,
          rootsManager,
          transport,
          createdAt: Date.now(),
          close,
        },
        { server: mcpServer, loggingState: rootsManager.loggingState },
      );
      rootsManager.logMissingDirectoriesIfNeeded(mcpServer);
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
    rootsManager,
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
  try {
    const sessionId = getSessionId(req);
    if (sessionId) {
      const session = registry.getOrRespondNotFound(sessionId, res);
      if (session) {
        await handleSessionTransportRequest(session, req, res, req.body);
      }
      return;
    }
    if (!isInitializeRequest(req.body)) {
      sendJsonRpcError(
        res,
        400,
        JSON_RPC_SERVER_ERROR,
        'Bad Request: No valid session ID provided',
      );
      return;
    }
    const maxSessions = parseEnvInt('FILESYSTEM_MCP_MAX_HTTP_SESSIONS', 100, 1, 10_000);
    if (registry.size() >= maxSessions) {
      sendJsonRpcError(res, 503, JSON_RPC_SERVER_ERROR, 'Too many sessions');
      return;
    }
    const session = await createHttpSession(options, registry, eventStore);
    await handleSessionTransportRequest(session, req, res, req.body);
  } catch (error) {
    Logger.error('[HTTP] Error handling POST request:', formatUnknownErrorMessage(error));
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, JSON_RPC_INTERNAL_ERROR, 'Internal Server Error');
    }
  }
}

async function handleGetOrDeleteMcp(
  req: Request,
  res: Response,
  registry: HttpSessionRegistry,
): Promise<void> {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) {
      sendJsonRpcError(res, 400, JSON_RPC_SERVER_ERROR, 'Bad Request: Missing session ID');
      return;
    }
    const session = registry.getOrRespondNotFound(sessionId, res);
    if (session) {
      await handleSessionTransportRequest(session, req, res);
    }
  } catch (error) {
    Logger.error(`[HTTP] Error handling ${req.method} request:`, formatUnknownErrorMessage(error));
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, JSON_RPC_INTERNAL_ERROR, 'Internal Server Error');
    }
  }
}

function setupExpressApp(
  httpHost: string,
  options: ServerOptions,
  registry: HttpSessionRegistry,
  eventStore: InMemoryEventStore,
): express.Express {
  const app = express();

  if (isLoopbackHttpHost(httpHost)) {
    app.use(localhostHostValidation());
  } else {
    app.use(hostHeaderValidation([httpHost]));
  }

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

  app.use(express.json({ limit: MAX_REQUEST_BODY_BYTES }));
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
  httpServer.requestTimeout = 30_000;
  httpServer.keepAliveTimeout = 5_000;

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
    httpServer
      .listen(port, httpHost, () => {
        Logger.info(`[HTTP] Server listening on http://${httpHost}:${port}`);
        resolve(httpServer);
      })
      .on('error', reject);
  });
}
