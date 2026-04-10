import { InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  isInitializeRequest,
  LATEST_PROTOCOL_VERSION,
  SetLevelRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { readFile } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { DEFAULT_LOG_LEVEL, parseEnvInt } from '../lib/constants.js';
import { formatUnknownErrorMessage } from '../lib/errors.js';
import {
  createLoggingState,
  type LogEvent,
  Logger,
  type LoggingState,
  logToMcp,
  SessionContext,
} from '../lib/logger.js';
import { withAllowedDirectoriesState } from '../lib/paths.js';
import { createInMemoryResourceStore } from '../lib/resource-store.js';

import { registerCompletions } from '../completions.js';
import { pkgInfo } from '../pkg-info.js';
import {
  registerAnalyzePathPrompt,
  registerCompareFilesPrompt,
  registerGetHelpPrompt,
  registerGetToolHelpPrompt,
} from '../prompts.js';
import {
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
import { RootsManager, type ServerOptions } from './roots-manager.js';
import { createTaskStore } from './task-store.js';

let cachedTaskToolSupport: boolean | undefined;

function detectTaskToolSupport(): boolean {
  if (cachedTaskToolSupport !== undefined) {
    return cachedTaskToolSupport;
  }

  try {
    // Instantiate a minimal, unconnected probe server to duck-type check for
    // task tool support. The probe has no transport or active connections, so
    // close() only releases in-memory state; fire-and-forget is safe here.
    const probe = new McpServer(
      {
        name: 'filesystem-mcp-capability-probe',
        version: '0.0.0',
      },
      { capabilities: { tools: {} } }
    );
    cachedTaskToolSupport =
      typeof probe.experimental.tasks.registerToolTask === 'function';
    probe.close().catch(() => {});
  } catch {
    cachedTaskToolSupport = false;
  }

  return cachedTaskToolSupport;
}

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

function supportsTaskToolRequests(): boolean {
  return detectTaskToolSupport();
}

// Global map of all active servers by sessionId for routing logs
export const activeServers = new Map<
  string,
  { server: McpServer; loggingState: LoggingState }
>();
// For stdio (single session without a specific ID)
export let stdioServer:
  | { server: McpServer; loggingState: LoggingState }
  | undefined;

function stringifyData(data: unknown): string {
  if (!data) return '';
  return ` ${typeof data === 'string' ? data : JSON.stringify(data)}`;
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
): Promise<McpServer> {
  const resourceStore = createInMemoryResourceStore();
  const serverInstructions = buildServerInstructions();
  const localIcon = await getLocalIconInfo();
  const taskToolSupport = supportsTaskToolRequests();

  const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> =
    {
      capabilities: buildServerCapabilities({
        enablePromptListChanged: false,
        enableTaskToolRequests: taskToolSupport,
      }),
    };

  if (taskToolSupport) {
    // Enabling task tool support requires configuring a task store and message queue on the server config. We use in-memory implementations from the SDK which auto-evict tasks after their TTL expires (via setTimeout). Suitable for both stdio and HTTP sessions.
    serverConfig.taskStore = createTaskStore();
    serverConfig.taskMessageQueue = new InMemoryTaskMessageQueue();
  }

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
  server.server.setRequestHandler(SetLevelRequestSchema, (req) => {
    loggingState.minimumLevel = req.params.level;
    Logger.notice(`Log level set to ${req.params.level}`);
    return {};
  });

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
  registerCompletions(server, serverInstructions);
  registerAllTools(server, {
    resourceStore,
    isInitialized: () => rootsManager.isInitialized(),
    ...(localIcon ? { iconInfo: localIcon } : {}),
  });

  return server;
}

export async function startServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  const rootsManager = getRootsManager(server);

  rootsManager.registerHandlers(server);
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
          req.pause(); // stop emitting data events; TCP window fills naturally
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
  transport: StreamableHTTPServerTransport;
  negotiatedProtocolVersion: string;
}

async function createHttpSession(
  options: ServerOptions,
  sessions: Map<string, HttpSession>,
  negotiatedProtocolVersion: string
): Promise<HttpSession> {
  const mcpServer = await createServer(options);
  const rootsManager = getRootsManager(mcpServer);

  rootsManager.registerHandlers(mcpServer);
  await rootsManager.recomputeAllowedDirectories();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, {
        server: mcpServer,
        rootsManager,
        transport,
        negotiatedProtocolVersion,
      });
      activeServers.set(sessionId, {
        server: mcpServer,
        loggingState: rootsManager['loggingState'],
      });
      rootsManager.logMissingDirectoriesIfNeeded(mcpServer);
    },
  });

  transport.onclose = () => {
    const { sessionId } = transport;
    if (sessionId) {
      sessions.delete(sessionId);
      activeServers.delete(sessionId);
    }
    rootsManager.destroy();
    mcpServer.close().catch((err: unknown) => {
      Logger.error(
        '[HTTP] Error closing MCP server:',
        formatUnknownErrorMessage(err)
      );
    });
  };

  await mcpServer.connect(transport as unknown as Transport);

  return {
    server: mcpServer,
    rootsManager,
    transport,
    negotiatedProtocolVersion,
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
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INTERNAL_ERROR = -32603;

function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true; // Non-browser clients omit Origin.
  return LOCALHOST_ORIGIN_RE.test(origin);
}

function getSessionId(req: IncomingMessage): string | undefined {
  const rawSessionId = req.headers['mcp-session-id'];
  return typeof rawSessionId === 'string' &&
    rawSessionId.length <= MAX_SESSION_ID_LENGTH
    ? rawSessionId
    : undefined;
}

function getProtocolVersionHeader(req: IncomingMessage): string | undefined {
  const rawProtocolVersion = req.headers['mcp-protocol-version'];
  return typeof rawProtocolVersion === 'string'
    ? rawProtocolVersion
    : undefined;
}

function resolveNegotiatedProtocolVersion(requestedVersion: string): string {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
    ? requestedVersion
    : LATEST_PROTOCOL_VERSION;
}

function ensureSessionProtocolVersion(
  req: IncomingMessage,
  res: ServerResponse,
  session: HttpSession
): boolean {
  const protocolVersion = getProtocolVersionHeader(req);
  if (!protocolVersion) {
    sendJsonRpcError(
      res,
      400,
      JSON_RPC_SERVER_ERROR,
      'Bad Request: Missing MCP-Protocol-Version header'
    );
    return false;
  }

  if (protocolVersion !== session.negotiatedProtocolVersion) {
    sendJsonRpcError(
      res,
      400,
      JSON_RPC_SERVER_ERROR,
      `Bad Request: MCP-Protocol-Version must match negotiated version ${session.negotiatedProtocolVersion}`
    );
    return false;
  }

  return true;
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
  const apiKey = process.env['FILESYSTEM_MCP_API_KEY'];
  if (!apiKey) return true;
  if (isAuthorizedBearer(apiKey, req.headers['authorization'])) return true;
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
    await withAllowedDirectoriesState(
      session.rootsManager.getAllowedDirectoriesState(),
      () => session.transport.handleRequest(req, res, body)
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
  if (process.env['FILESYSTEM_MCP_API_KEY']) return;
  throw new Error(
    `Refusing to bind HTTP server to non-loopback host '${host}' without FILESYSTEM_MCP_API_KEY.`
  );
}

function writeMethodNotAllowedResponse(res: ServerResponse): void {
  res.writeHead(405, {
    Allow: 'GET, POST, DELETE',
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
  const httpHost = process.env['FILESYSTEM_MCP_HTTP_HOST'] ?? '127.0.0.1';
  assertHttpBindingSecurity(httpHost);

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
      if (!ensureSessionProtocolVersion(req, res, session)) {
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
      const session = await createHttpSession(
        options,
        sessions,
        resolveNegotiatedProtocolVersion(body.params.protocolVersion)
      );
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
    if (!ensureSessionProtocolVersion(req, res, session)) return;
    await handleSessionTransportRequest(session, req, res);
  }

  async function dispatchMcpMethod(
    method: string | undefined,
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string | undefined
  ): Promise<void> {
    switch (method) {
      case 'POST':
        await handlePostRequest(req, res, sessionId);
        return;
      case 'GET':
      case 'DELETE':
        await handleGetDeleteRequest(req, res, sessionId);
        return;
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
    if (!ensureAuthorizedRequest(req, res)) return;

    try {
      await dispatchMcpMethod(req.method, req, res, sessionId);
    } catch (error: unknown) {
      handleHttpRequestError(error, res);
    }
  }

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

  return new Promise<Server>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, httpHost, () => {
      Logger.info(`MCP HTTP server listening on ${httpHost}:${port}`);
      resolve(httpServer);
    });
  });
}
