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
import { channel } from 'node:diagnostics_channel';
import { readFile } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { inspect } from 'node:util';

import express, {
  type NextFunction,
  type Request,
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
  type LogEvent,
  Logger,
  type LoggingState,
  logToMcp,
  SessionContext,
} from '../lib/logger.js';
import { withPathGuard } from '../lib/paths.js';
import { createInMemoryResourceStore } from '../lib/resource-store.js';

import { pkgInfo } from '../pkg-info.js';
import {
  registerAnalyzePathPrompt,
  registerCompareFilesPrompt,
  registerGetHelpPrompt,
} from '../prompts.js';
import {
  registerAllResources,
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
    resources: {},
    tools: {},
    prompts: options.enablePromptListChanged ? { listChanged: true } : {},
    completions: {},
    extensions: {},
  };

  if (options.enableTaskToolRequests) {
    // NOTE: enabling task tool requests requires the caller to configure
    // an InMemoryTaskStore and InMemoryTaskMessageQueue on the McpServer.
    // InMemoryTaskStore auto-evicts tasks after TTL via setTimeout.
    capabilities.tasks = {
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
    };
  }

  return capabilities;
}

// Global map of all active servers by sessionId for routing logs
const activeServers = new Map<
  string,
  { server: McpServer; loggingState: LoggingState }
>();
// For stdio (single session without a specific ID)
let stdioServer: { server: McpServer; loggingState: LoggingState } | undefined;

function stringifyData(data: unknown): string {
  if (data === undefined) return '';
  if (typeof data === 'string') return ` ${data}`;
  if (
    data === null ||
    typeof data === 'number' ||
    typeof data === 'boolean' ||
    typeof data === 'bigint'
  ) {
    return ` ${String(data)}`;
  }
  return ` ${inspect(data, { depth: 4, colors: false, compact: 3 })}`;
}

channel('filesystem-mcp:log').subscribe((message) => {
  const event = message as LogEvent;
  const target = event.sessionId
    ? activeServers.get(event.sessionId)
    : stdioServer;
  const dataStr = stringifyData(event.data);
  if (target) {
    logToMcp(
      target.server,
      event.level,
      `${event.message}${dataStr}`,
      target.loggingState.minimumLevel
    );
  } else {
    // Fallback if no server
    const fullMsg = `${event.message}${dataStr}`;
    console.error(`[${event.level.toUpperCase()}] ${fullMsg}`);
  }
});

const {
  version: SERVER_VERSION,
  description: SERVER_DESCRIPTION,
  homepage: SERVER_HOMEPAGE,
} = pkgInfo;

const rootsManagers = new WeakMap<McpServer, RootsManager>();

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

  // Track stdio server by default, or it will be overwritten per HTTP session later
  stdioServer ??= { server, loggingState };

  registerAllResources(server, {
    resourceStore,
    ...(localIcon ? { iconInfo: localIcon } : {}),
  });

  registerGetHelpPrompt(server, serverInstructionsContent, localIcon);
  registerCompareFilesPrompt(server, localIcon);
  registerAnalyzePathPrompt(server, localIcon);
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
    rootsManager.destroy();
    sdkOnClose?.();
  };

  rootsManager.logMissingDirectoriesIfNeeded(server);
}

const MAX_REQUEST_BODY_BYTES = parseEnvInt(
  'FS_CONTEXT_MAX_REQUEST_BYTES',
  4 * 1024 * 1024,
  1024,
  256 * 1024 * 1024
);

interface HttpSession {
  server: McpServer;
  rootsManager: RootsManager;
  transport: NodeStreamableHTTPServerTransport;
  createdAt: number;
  cleanup: () => void;
  close: () => Promise<void>;
}

async function createHttpSession(
  options: ServerOptions,
  sessions: Map<string, HttpSession>,
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

    const { sessionId } = transport;
    if (sessionId) {
      sessions.delete(sessionId);
      activeServers.delete(sessionId);
      eventStore.delete(sessionId);
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
      sessions.set(sessionId, {
        server: mcpServer,
        rootsManager,
        transport,
        createdAt: Date.now(),
        cleanup,
        close,
      });
      activeServers.set(sessionId, {
        server: mcpServer,
        loggingState: rootsManager.loggingState,
      });
      rootsManager.logMissingDirectoriesIfNeeded(mcpServer);
    },
    onsessionclosed: async (sessionId) => {
      const session = sessions.get(sessionId);
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
    cleanup,
    close,
  };
}

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

const MAX_SESSION_ID_LENGTH = 256;
const MAX_BEARER_TOKEN_LENGTH = 4096;
const JSON_RPC_SERVER_ERROR = -32000;
const JSON_RPC_INVALID_REQUEST = ProtocolErrorCode.InvalidRequest;
const JSON_RPC_PARSE_ERROR = ProtocolErrorCode.ParseError;
const JSON_RPC_INTERNAL_ERROR = ProtocolErrorCode.InternalError;

function getSessionId(req: IncomingMessage): string | undefined {
  const rawSessionId = req.headers['mcp-session-id'];
  return typeof rawSessionId === 'string' &&
    rawSessionId.length <= MAX_SESSION_ID_LENGTH
    ? rawSessionId
    : undefined;
}

function isAuthorizedBearer(apiKey: string, authHeader: unknown): boolean {
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

function writeUnauthorizedResponse(res: ServerResponse): void {
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
}

function ensureAuthorizedRequest(
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  const apiKey = process.env.FILESYSTEM_MCP_API_KEY;
  if (!apiKey) return true;
  if (isAuthorizedBearer(apiKey, req.headers.authorization)) return true;
  writeUnauthorizedResponse(res);
  return false;
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
    await withPathGuard(session.rootsManager.pathGuard, () =>
      session.transport.handleRequest(req, res, body)
    );
  });
}

function getSessionOrRespondNotFound(
  sessions: Map<string, HttpSession>,
  sessionId: string,
  res: ServerResponse
): HttpSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) {
    sendJsonRpcError(res, 404, JSON_RPC_SERVER_ERROR, 'Session not found');
    return undefined;
  }
  return session;
}

function isLoopbackHttpHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

function assertHttpBindingSecurity(host: string): void {
  if (isLoopbackHttpHost(host)) return;
  if (process.env.FILESYSTEM_MCP_API_KEY) return;
  throw new Error(
    `Refusing to bind HTTP server to non-loopback host '${host}' without FILESYSTEM_MCP_API_KEY.`
  );
}

export async function startHttpServer(
  port: number,
  options: ServerOptions
): Promise<Server> {
  const sessions = new Map<string, HttpSession>();
  const eventStore = new InMemoryEventStore();
  const httpHost = process.env.FILESYSTEM_MCP_HTTP_HOST ?? '127.0.0.1';
  assertHttpBindingSecurity(httpHost);

  const app = createMcpExpressApp({
    host: httpHost,
    allowedHosts: isLoopbackHttpHost(httpHost)
      ? localhostAllowedHostnames()
      : [httpHost],
  });

  // Origin validation middleware for browser CORS requests
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('origin');
    if (origin) {
      // Only allow localhost origins
      const allowedOriginPatterns = [
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u,
      ];
      const isAllowed = allowedOriginPatterns.some((pattern) =>
        pattern.test(origin)
      );
      if (!isAllowed) {
        res.status(403).send('Forbidden: disallowed origin');
        return;
      }
    }
    next();
  });

  // Bearer auth middleware — runs before all /mcp requests
  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    if (!ensureAuthorizedRequest(req, res)) return;
    next();
  });

  // Body parsing with size cap
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
          const session = getSessionOrRespondNotFound(sessions, sessionId, res);
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
          if (sessions.size >= maxSessions) {
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
            sessions,
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
        const session = getSessionOrRespondNotFound(sessions, sessionId, res);
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

  // Stale session sweep — unchanged
  const initHandshakeTimeoutMs = getInitHandshakeTimeoutMs();
  const SWEEP_INTERVAL_MS = initHandshakeTimeoutMs * 2;
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (
        !session.rootsManager.isInitialized() &&
        now - session.createdAt > initHandshakeTimeoutMs
      ) {
        Logger.warn(`[HTTP] Evicting stale session ${sessionId}`);
        session.close().catch((err: unknown) => {
          Logger.error(
            `[HTTP] Error closing stale session ${sessionId}:`,
            formatUnknownErrorMessage(err)
          );
          eventStore.delete(sessionId);
        });
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  httpServer.once('close', () => {
    clearInterval(sweepTimer);
    for (const session of sessions.values()) {
      session.close().catch((err: unknown) => {
        Logger.error(
          '[HTTP] Error closing session on shutdown:',
          formatUnknownErrorMessage(err)
        );
      });
    }
    eventStore.clear();
  });

  const originalClose = httpServer.close.bind(httpServer);
  httpServer.close = function (callback?: (error?: Error) => void) {
    for (const session of sessions.values()) {
      session.close().catch((err: unknown) => {
        Logger.error(
          '[HTTP] Error closing session:',
          formatUnknownErrorMessage(err)
        );
      });
    }
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
