import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import {
  InMemoryTaskMessageQueue,
  isInitializeRequest,
  localhostAllowedHostnames,
  McpServer,
  ProtocolErrorCode,
  type SetLevelRequest,
  StdioServerTransport,
} from '@modelcontextprotocol/server';

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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

import {
  DEFAULT_LOG_LEVEL,
  getInitHandshakeTimeoutMs,
  INIT_TIMEOUT_CLOSE,
  parseEnvInt,
} from '../lib/constants.js';
import { formatUnknownErrorMessage } from '../lib/errors.js';
import {
  createLoggingState,
  Logger,
  LogRouter,
  type LogTarget,
  SessionContext,
} from '../lib/logger.js';
import { createInMemoryResourceStore } from '../lib/resource-store.js';

import { pkgInfo } from '../pkg-info.js';
import {
  registerAnalyzePathPrompt,
  registerCompareFilesPrompt,
  registerGetHelpPrompt,
} from '../prompts.js';
import {
  registerAllResources,
  type ResourcesHandle,
  serverInstructionsContent,
} from '../resources.js';
import { registerAllTools } from '../tools.js';
import { type IconInfo, withDefaultIcons } from '../tools/shared.js';
import { InMemoryEventStore } from './event-store.js';
import { RootsManager, type ServerOptions } from './roots-manager.js';
import { createTaskStore } from './task-store.js';

interface CapabilityOptions {
  enablePromptListChanged?: boolean;
  enableTaskToolRequests?: boolean;
}

type ServerCapabilities = NonNullable<
  ConstructorParameters<typeof McpServer>[1]
>['capabilities'];

type NonOptionalServerCapabilities = NonNullable<ServerCapabilities>;

function buildServerCapabilities(
  options: CapabilityOptions = {}
): NonOptionalServerCapabilities {
  const capabilities: NonOptionalServerCapabilities = {
    logging: {},
    resources: { subscribe: true, listChanged: true },
    tools: {},
    prompts: options.enablePromptListChanged ? { listChanged: true } : {},
    completions: {},
    extensions: {},
  };

  if (options.enableTaskToolRequests) {
    capabilities.tasks = {
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
    };
  }

  return capabilities;
}

const logRouter = LogRouter.global();

const {
  version: SERVER_VERSION,
  description: SERVER_DESCRIPTION,
  homepage: SERVER_HOMEPAGE,
} = pkgInfo;

const rootsManagers = new WeakMap<McpServer, RootsManager>();
const resourceHandles = new WeakMap<McpServer, ResourcesHandle>();

function getRootsManager(server: McpServer): RootsManager {
  const manager = rootsManagers.get(server);
  if (!manager) {
    throw new Error('Roots manager not initialized for server instance');
  }
  return manager;
}

async function getLocalIconInfo(): Promise<IconInfo | undefined> {
  const name = 'logo.svg';
  const mime = 'image/svg+xml';
  const candidates = [`../assets/${name}`, `../../assets/${name}`];

  for (const candidate of candidates) {
    try {
      const iconPath = new URL(candidate, import.meta.url);
      const buffer = await readFile(iconPath);
      return {
        src: `data:${mime};base64,${buffer.toString('base64')}`,
        mimeType: mime,
      };
    } catch {
      // Try next candidate.
    }
  }

  return undefined;
}

export async function createServer(
  options: ServerOptions = {}
): Promise<{ server: McpServer }> {
  const resourceStore = createInMemoryResourceStore();
  const localIcon = await getLocalIconInfo();
  const capabilities = buildServerCapabilities({
    enablePromptListChanged: false,
    enableTaskToolRequests: true,
  });

  if (capabilities.tasks) {
    capabilities.tasks = {
      ...capabilities.tasks,
      taskStore: createTaskStore(),
      taskMessageQueue: new InMemoryTaskMessageQueue(),
    };
  }

  const hasTaskSupport =
    capabilities.tasks?.requests?.tools?.call !== undefined;

  const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> =
    {
      capabilities,
      enforceStrictCapabilities: true,
    };

  serverConfig.instructions =
    'filesystem-mcp: Secure local filesystem MCP server. ' +
    'Start with: roots -> ls/find -> stat -> read. Never guess paths. ' +
    'For full guidance, read internal://instructions or run the get-help prompt.';

  const server = new McpServer(
    withDefaultIcons(
      {
        name: 'filesystem-mcp',
        title: 'Filesystem MCP',
        version: SERVER_VERSION,
        ...(SERVER_DESCRIPTION ? { description: SERVER_DESCRIPTION } : {}),
        ...(SERVER_HOMEPAGE ? { websiteUrl: SERVER_HOMEPAGE } : {}),
      },
      localIcon
    ),
    serverConfig
  );

  const loggingState = createLoggingState(DEFAULT_LOG_LEVEL);
  const rootsManager = new RootsManager(options, loggingState);
  rootsManagers.set(server, rootsManager);

  // Subscribe to Logger channel if not already done, but we need to route based on session or fallback to this server if it's stdio.
  // Wait, in stdio there's only one server. In HTTP there are multiple.
  server.server.setRequestHandler(
    'logging/setLevel',
    (req: SetLevelRequest) => {
      loggingState.minimumLevel = req.params.level;
      Logger.notice(`Log level set to ${req.params.level}`);
      return {};
    }
  );

  // Track stdio server by default; HTTP overrides per-session via the registry.
  logRouter.attachStdio({ server, loggingState });

  const resourcesHandle = registerAllResources(server, {
    resourceStore,
    pathGuard: rootsManager.pathGuard,
    ...(localIcon ? { iconInfo: localIcon } : {}),
  });
  resourceHandles.set(server, resourcesHandle);

  registerGetHelpPrompt(server, serverInstructionsContent, localIcon);
  registerCompareFilesPrompt(server, rootsManager.pathGuard, localIcon);
  registerAnalyzePathPrompt(server, rootsManager.pathGuard, localIcon);
  registerAllTools(server, {
    pathGuard: rootsManager.pathGuard,
    resourceStore,
    isInitialized: () => rootsManager.isInitialized(),
    hasTaskSupport,
    ...(localIcon ? { iconInfo: localIcon } : {}),
  });

  return { server };
}

export async function startServer(serverAndHandle: {
  server: McpServer;
}): Promise<void> {
  const { server } = serverAndHandle;
  const transport = new StdioServerTransport();
  const rootsManager = getRootsManager(server);

  rootsManager.registerHandlers(
    server,
    INIT_TIMEOUT_CLOSE
      ? () => {
          void server.close();
        }
      : undefined
  );
  await rootsManager.recomputeAllowedDirectories();
  await server.connect(transport);
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    resourceHandles.get(server)?.destroy();
    rootsManager.destroy();
    logRouter.detachStdio();
    sdkOnClose?.();
  };

  rootsManager.logMissingDirectoriesIfNeeded(server);
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
  message: string
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    })
  );
}

function getSessionId(req: IncomingMessage): string | undefined {
  const rawSessionId = req.headers['mcp-session-id'];
  return typeof rawSessionId === 'string' &&
    rawSessionId.length <= MAX_SESSION_ID_LENGTH
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

export function validateBearerAuthorization(
  apiKey: string,
  authHeader: unknown
): boolean {
  const bearerPrefix = 'Bearer ';
  if (typeof authHeader !== 'string' || !authHeader.startsWith(bearerPrefix)) {
    return false;
  }
  const userKey = authHeader.slice(bearerPrefix.length);
  if (userKey.length > MAX_BEARER_TOKEN_LENGTH) {
    return false;
  }
  const expectedHash = createHash('sha256').update(apiKey).digest();
  const actualHash = createHash('sha256').update(userKey).digest();
  return timingSafeEqual(expectedHash, actualHash);
}

/**
 * Refuse to bind to a non-loopback host without an API key. Throws on
 * policy violation; returns silently when allowed.
 */
export function assertHttpBindingPolicy(
  host: string,
  apiKey: string | undefined
): void {
  if (isLoopbackHttpHost(host)) return;
  if (apiKey) return;
  throw new Error(
    `Refusing to bind HTTP server to non-loopback host '${host}' without FILESYSTEM_MCP_API_KEY.`
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
  return (req: Request, res: Response, next: NextFunction): void => {
    const apiKey = process.env.FILESYSTEM_MCP_API_KEY;
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
      })
    );
  };
}

// ---------------------------------------------------------------------------
// HttpSessionRegistry — owns session map, sweep timer, log-router wiring
// ---------------------------------------------------------------------------

interface HttpSession {
  server: McpServer;
  rootsManager: RootsManager;
  transport: NodeStreamableHTTPServerTransport;
  createdAt: number;
  close: () => Promise<void>;
}

export type { HttpSession };

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

  getOrRespondNotFound(
    sessionId: string,
    res: ServerResponse
  ): HttpSession | undefined {
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
            formatUnknownErrorMessage(err)
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
        Logger.error(
          '[HTTP] Error closing session on shutdown:',
          formatUnknownErrorMessage(err)
        );
      })
    );
    await Promise.allSettled(closes);
    this.eventStore.clear();
  }
}

const MAX_REQUEST_BODY_BYTES = parseEnvInt(
  'FS_CONTEXT_MAX_REQUEST_BYTES',
  4 * 1024 * 1024,
  1024,
  256 * 1024 * 1024
);

async function createHttpSession(
  options: ServerOptions,
  registry: HttpSessionRegistry,
  eventStore: InMemoryEventStore
): Promise<HttpSession> {
  const { server: mcpServer } = await createServer(options);
  const rootsManager = getRootsManager(mcpServer);

  rootsManager.registerHandlers(mcpServer);
  await rootsManager.recomputeAllowedDirectories();

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    resourceHandles.get(mcpServer)?.destroy();
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
        { server: mcpServer, loggingState: rootsManager.loggingState }
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
  body?: unknown
): Promise<void> {
  const store = session.transport.sessionId
    ? { sessionId: session.transport.sessionId }
    : {};
  await SessionContext.run(store, async () => {
    await session.transport.handleRequest(req, res, body);
  });
}

export async function startHttpServer(
  port: number,
  options: ServerOptions
): Promise<Server> {
  const eventStore = new InMemoryEventStore();
  const httpHost = process.env.FILESYSTEM_MCP_HTTP_HOST ?? '127.0.0.1';
  assertHttpBindingPolicy(httpHost, process.env.FILESYSTEM_MCP_API_KEY);

  const registry = new HttpSessionRegistry({
    eventStore,
    logRouter,
    handshakeTimeoutMs: getInitHandshakeTimeoutMs(),
  });

  const app = createMcpExpressApp({
    host: httpHost,
    allowedHosts: isLoopbackHttpHost(httpHost)
      ? localhostAllowedHostnames()
      : [httpHost],
  });

  app.use(originGuardMiddleware());
  app.use('/mcp', bearerAuthMiddleware());

  app.use(express.json({ limit: MAX_REQUEST_BODY_BYTES, strict: false }));

  // Body-parse error handler — translate to JSON-RPC error format
  app.use(
    (
      err: Error & { status?: number },
      _req: Request,
      res: Response,
      next: NextFunction
    ) => {
      if (err.status === 413) {
        sendJsonRpcError(
          res,
          413,
          JSON_RPC_INVALID_REQUEST,
          'Request body too large'
        );
        return;
      }
      if (err.status === 400) {
        sendJsonRpcError(
          res,
          400,
          JSON_RPC_PARSE_ERROR,
          'Invalid JSON in request body'
        );
        return;
      }
      next(err);
    }
  );

  app.all('/mcp', async (req: Request, res: Response) => {
    try {
      const sessionId = getSessionId(req);

      if (req.method === 'POST') {
        if (sessionId) {
          const session = registry.getOrRespondNotFound(sessionId, res);
          if (session)
            await handleSessionTransportRequest(session, req, res, req.body);
          return;
        }
        if (isInitializeRequest(req.body)) {
          const maxSessions = parseEnvInt(
            'FILESYSTEM_MCP_MAX_HTTP_SESSIONS',
            100,
            1,
            10_000
          );
          if (registry.size() >= maxSessions) {
            sendJsonRpcError(
              res,
              503,
              JSON_RPC_SERVER_ERROR,
              'Too many sessions'
            );
            return;
          }
          const session = await createHttpSession(
            options,
            registry,
            eventStore
          );
          await handleSessionTransportRequest(session, req, res, req.body);
          return;
        }
        sendJsonRpcError(
          res,
          400,
          JSON_RPC_SERVER_ERROR,
          'Bad Request: No valid session ID provided'
        );
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        if (!sessionId) {
          sendJsonRpcError(
            res,
            400,
            JSON_RPC_SERVER_ERROR,
            'Bad Request: Missing session ID'
          );
          return;
        }
        const session = registry.getOrRespondNotFound(sessionId, res);
        if (session) await handleSessionTransportRequest(session, req, res);
        return;
      }

      // Unsupported method
      res.status(405).set('Allow', 'GET, POST, DELETE, OPTIONS');
      sendJsonRpcError(res, 405, JSON_RPC_SERVER_ERROR, 'Method Not Allowed');
    } catch (error) {
      Logger.error(
        '[HTTP] Error handling request:',
        formatUnknownErrorMessage(error)
      );
      if (!res.headersSent) {
        sendJsonRpcError(
          res,
          500,
          JSON_RPC_INTERNAL_ERROR,
          'Internal Server Error'
        );
      }
    }
  });

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
