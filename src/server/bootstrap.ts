import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import {
  InMemoryTaskMessageQueue,
  isInitializeRequest,
  localhostAllowedHostnames,
  McpServer,
  ProtocolErrorCode,
  type SetLevelRequest,
  StdioServerTransport,
  validateHostHeader,
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
import { onMetricsUpdate } from '../lib/observability.js';
import { withPathGuard } from '../lib/paths.js';
import { createInMemoryResourceStore } from '../lib/resource-store.js';

import { pkgInfo } from '../pkg-info.js';
import {
  registerAnalyzePathPrompt,
  registerCompareFilesPrompt,
  registerGetHelpPrompt,
  registerGetToolHelpPrompt,
} from '../prompts.js';
import {
  METRICS_RESOURCE_URI,
  registerInstructionResource,
  registerMetricsResource,
  registerResultResources,
  registerToolCatalogResource,
  registerToolInfoResource,
  registerWorkflowGuideResource,
} from '../resources.js';
import { buildServerInstructions } from '../resources/generated-instructions.js';
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
    resources: { listChanged: true, subscribe: true },
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

const metricsUnsubscribers = new WeakMap<McpServer, () => void>();

function cleanupServerMetrics(server: McpServer): void {
  metricsUnsubscribers.get(server)?.();
  metricsUnsubscribers.delete(server);
}

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
): Promise<McpServer> {
  const resourceStore = createInMemoryResourceStore();
  const serverInstructions = buildServerInstructions();
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

  const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> =
    {
      capabilities,
      enforceStrictCapabilities: true,
      debouncedNotificationMethods: [
        'notifications/resources/list_changed',
        'notifications/resources/updated',
      ],
    };

  if (serverInstructions) {
    serverConfig.instructions =
      'filesystem-mcp: Secure local filesystem MCP server. ' +
      'Start with: roots -> ls/find -> stat -> read. Never guess paths. ' +
      'For full guidance, read internal://instructions or run the get-help prompt.';
  }

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

  registerInstructionResource(server, serverInstructions, localIcon);
  registerToolCatalogResource(server, localIcon);
  registerWorkflowGuideResource(server, localIcon);
  registerToolInfoResource(server, localIcon);
  registerGetHelpPrompt(server, serverInstructions, localIcon);
  registerCompareFilesPrompt(server, localIcon);
  registerAnalyzePathPrompt(server, localIcon);
  registerGetToolHelpPrompt(server, localIcon);
  registerResultResources(server, resourceStore, localIcon);
  registerMetricsResource(server, localIcon);
  registerAllTools(server, {
    pathGuard: rootsManager.pathGuard,
    resourceStore,
    isInitialized: () => rootsManager.isInitialized(),
    ...(localIcon ? { iconInfo: localIcon } : {}),
  });

  // Subscribe to metrics updates and push resource notifications to this server instance.
  // The debounce (500 ms) prevents notification floods during batch tool runs.
  let metricsNotifyTimer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribeMetrics = onMetricsUpdate(() => {
    clearTimeout(metricsNotifyTimer);
    metricsNotifyTimer = setTimeout(() => {
      void server.server
        .sendResourceUpdated({ uri: METRICS_RESOURCE_URI })
        .catch(() => {
          // Transport may already be closed — best effort.
        });
    }, 500);
  });

  // Store unsubscribe so HTTP session cleanup and stdio shutdown can call it.
  metricsUnsubscribers.set(server, () => {
    clearTimeout(metricsNotifyTimer);
    unsubscribeMetrics();
  });

  return server;
}

export async function startServer(server: McpServer): Promise<void> {
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
    cleanupServerMetrics(server);
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

class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'RequestBodyError';
  }
}

async function readRequestBody(req: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        if (!tooBig) {
          tooBig = true;
          chunks.length = 0; // free accumulated memory
          req.resume(); // drain so the connection can be cleanly closed
          reject(new RequestBodyError('Request body too large', 413));
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) return; // already rejected in 'data' handler
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(new RequestBodyError('Invalid JSON in request body', 400));
      }
    });
    req.on('error', reject);
  });
}

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
  const mcpServer = await createServer(options);
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

    cleanupServerMetrics(mcpServer);
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

const LOCALHOST_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_BEARER_TOKEN_LENGTH = 4096;
const JSON_RPC_SERVER_ERROR = -32000;
const JSON_RPC_INVALID_REQUEST = ProtocolErrorCode.InvalidRequest;
const JSON_RPC_PARSE_ERROR = ProtocolErrorCode.ParseError;
const JSON_RPC_INTERNAL_ERROR = ProtocolErrorCode.InternalError;

function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true; // Non-browser clients omit Origin.
  return LOCALHOST_ORIGIN_RE.test(origin);
}

const EXPOSED_HEADERS = [
  'WWW-Authenticate',
  'Mcp-Session-Id',
  'Mcp-Protocol-Version',
].join(', ');

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const { origin } = req.headers;
  if (origin === undefined) return;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Mcp-Session-Id, Last-Event-ID'
  );
  res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
  res.setHeader('Access-Control-Max-Age', '86400');
}

function normalizeAllowedHostname(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed === '::1') return '[::1]';
  return trimmed;
}

function getAllowedHostnames(httpHost: string): string[] | undefined {
  if (isLoopbackHttpHost(httpHost)) {
    return localhostAllowedHostnames().map(normalizeAllowedHostname);
  }

  const normalizedHost = normalizeAllowedHostname(httpHost);
  if (
    normalizedHost === '0.0.0.0' ||
    normalizedHost === '::' ||
    normalizedHost === '[::]'
  ) {
    return undefined;
  }

  return [normalizedHost];
}

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

function ensureAllowedOrigin(
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  const { origin } = req.headers;
  if (isAllowedOrigin(origin)) {
    return true;
  }

  sendJsonRpcError(
    res,
    403,
    JSON_RPC_SERVER_ERROR,
    'Forbidden: disallowed origin'
  );
  return false;
}

function ensureAllowedHostHeader(
  req: IncomingMessage,
  res: ServerResponse,
  httpHost: string
): boolean {
  const allowedHostnames = getAllowedHostnames(httpHost);
  if (!allowedHostnames || allowedHostnames.length === 0) {
    return true;
  }

  const hostHeader =
    typeof req.headers.host === 'string' ? req.headers.host : undefined;
  const result = validateHostHeader(hostHeader, allowedHostnames);
  if (result.ok) return true;

  sendJsonRpcError(
    res,
    403,
    JSON_RPC_SERVER_ERROR,
    `Forbidden: ${result.message}`
  );
  return false;
}

function discardRequestBody(req: IncomingMessage): void {
  req.on('error', () => {
    // Best effort drain to avoid corrupting keep-alive pipelines.
  });
  req.resume();
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

function writeMethodNotAllowedResponse(res: ServerResponse): void {
  res.writeHead(405, {
    Allow: 'GET, POST, DELETE, OPTIONS',
    'Content-Type': 'application/json',
  });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: JSON_RPC_SERVER_ERROR,
        message: 'Method Not Allowed',
      },
      id: null,
    })
  );
}

function handleHttpRequestError(error: unknown, res: ServerResponse): void {
  if (error instanceof RequestBodyError && !res.headersSent) {
    const rpcCode =
      error.statusCode === 413
        ? JSON_RPC_INVALID_REQUEST
        : JSON_RPC_PARSE_ERROR;
    res.setHeader('Connection', 'close');
    sendJsonRpcError(res, error.statusCode, rpcCode, error.message);
    return;
  }

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

export async function startHttpServer(
  port: number,
  options: ServerOptions
): Promise<Server> {
  const sessions = new Map<string, HttpSession>();
  const eventStore = new InMemoryEventStore();
  const httpHost = process.env.FILESYSTEM_MCP_HTTP_HOST ?? '127.0.0.1';
  assertHttpBindingSecurity(httpHost);
  let closingSessions: Promise<void> | undefined;

  async function closeAllSessions(): Promise<void> {
    if (closingSessions) return closingSessions;

    closingSessions = (async () => {
      const activeSessions = [...sessions.values()];
      sessions.clear();
      eventStore.clear();

      await Promise.allSettled(
        activeSessions.map((session) => session.close())
      );
    })();

    await closingSessions;
  }

  async function handlePostRequest(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string | undefined
  ): Promise<void> {
    if (sessionId) {
      const session = getSessionOrRespondNotFound(sessions, sessionId, res);
      if (!session) {
        discardRequestBody(req);
        return;
      }

      const body = await readRequestBody(req);
      await handleSessionTransportRequest(session, req, res, body);
      return;
    }

    const body = await readRequestBody(req);
    if (isInitializeRequest(body)) {
      const maxSessions = parseEnvInt(
        'FILESYSTEM_MCP_MAX_HTTP_SESSIONS',
        100,
        1,
        10_000
      );
      if (sessions.size >= maxSessions) {
        sendJsonRpcError(res, 503, JSON_RPC_SERVER_ERROR, 'Too many sessions');
        return;
      }
      const session = await createHttpSession(options, sessions, eventStore);
      await handleSessionTransportRequest(session, req, res, body);
      return;
    }

    sendJsonRpcError(
      res,
      400,
      JSON_RPC_SERVER_ERROR,
      'Bad Request: No valid session ID provided'
    );
    discardRequestBody(req);
  }

  async function handleGetDeleteRequest(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string | undefined
  ): Promise<void> {
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
    if (!session) return;
    await handleSessionTransportRequest(session, req, res);
  }

  async function dispatchMcpMethod(
    method: string | undefined,
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string | undefined
  ): Promise<void> {
    switch (method) {
      case 'OPTIONS':
        res.writeHead(204);
        res.end();
        return;
      case 'POST':
        await handlePostRequest(req, res, sessionId);
        return;
      case 'GET':
      case 'DELETE':
        await handleGetDeleteRequest(req, res, sessionId);
        return;
      case undefined:
      default:
        writeMethodNotAllowedResponse(res);
    }
  }

  async function handleMcpRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const sessionId = getSessionId(req);
    if (!ensureAllowedOrigin(req, res)) return;
    setCorsHeaders(req, res);
    if (!ensureAllowedHostHeader(req, res, httpHost)) return;
    if (!ensureAuthorizedRequest(req, res)) return;

    try {
      await dispatchMcpMethod(req.method, req, res, sessionId);
    } catch (error: unknown) {
      handleHttpRequestError(error, res);
    }
  }

  const initHandshakeTimeoutMs = getInitHandshakeTimeoutMs();
  const SWEEP_INTERVAL_MS = initHandshakeTimeoutMs * 2;
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (
        !session.rootsManager.isInitialized() &&
        now - session.createdAt > initHandshakeTimeoutMs
      ) {
        Logger.warn(
          `[HTTP] Evicting stale session ${sessionId}: client never sent notifications/initialized`
        );
        session.close().catch((err: unknown) => {
          Logger.error(
            `[HTTP] Error closing stale session ${sessionId}:`,
            formatUnknownErrorMessage(err)
          );
          // Ensure event store is cleaned even if session.close() fails
          eventStore.delete(sessionId);
        });
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  const httpServer = createHttpServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const urlPath = (req.url ?? '/').split('?')[0];
      if (urlPath === '/mcp') {
        handleMcpRequest(req, res).catch((err: unknown) => {
          Logger.error(
            '[HTTP] Unhandled error in request handler:',
            formatUnknownErrorMessage(err)
          );
        });
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    }
  );

  // Slowloris / slow-body DoS protection
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 30_000;
  httpServer.keepAliveTimeout = 5_000;

  httpServer.once('close', () => {
    clearInterval(sweepTimer);
  });

  const originalClose = httpServer.close.bind(httpServer);
  httpServer.close = (callback?: (error?: Error) => void) => {
    void closeAllSessions().catch((error: unknown) => {
      Logger.error(
        '[HTTP] Error closing sessions before server shutdown:',
        formatUnknownErrorMessage(error)
      );
    });
    return originalClose(callback);
  };

  return new Promise<Server>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, httpHost, () => {
      Logger.info(`MCP HTTP server listening on ${httpHost}:${port}`);
      // Persistent handler for errors after startup (once above is consumed on listen failure only).
      httpServer.on('error', (err: Error) => {
        Logger.error('[HTTP] Server runtime error:', err.message);
      });
      resolve(httpServer);
    });
  });
}
