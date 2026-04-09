import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
} from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  LoggingLevel,
  LoggingMessageNotificationParams,
} from '@modelcontextprotocol/sdk/types.js';
import {
  isInitializeRequest,
  LATEST_PROTOCOL_VERSION,
  SetLevelRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';

import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';

import { DEFAULT_LOG_LEVEL, parseEnvInt } from '../lib/constants.js';
import { formatUnknownErrorMessage } from '../lib/errors.js';
import { type LogEvent, Logger, SessionContext } from '../lib/logger.js';
import { withAllowedDirectoriesState } from '../lib/paths.js';
import { createInMemoryResourceStore } from '../lib/resource-store.js';
import { isRecord } from '../lib/utils.js';

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
import type { IconInfo } from '../tools/shared.js';
import { withDefaultIcons } from '../tools/shared.js';
import { RootsManager } from './roots-manager.js';

export interface ServerOptions {
  allowCwd?: boolean;
  cliAllowedDirs?: string[];
}

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

const MCP_LOGGER_NAME = 'filesystem-mcp';

const LOG_LEVEL_ORDER: Record<LoggingLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7,
};

export interface LoggingState {
  minimumLevel: LoggingLevel;
}

function createLoggingState(
  minimumLevel: LoggingLevel = 'debug'
): LoggingState {
  return { minimumLevel };
}

export function canSendMcpLogs(server: McpServer): boolean {
  const capabilities = server.server.getClientCapabilities();
  if (!isRecord(capabilities)) return false;
  if (!('logging' in capabilities)) return false;
  return !!capabilities['logging'];
}

export function logToMcp(
  server: McpServer | undefined,
  level: LoggingLevel,
  data: string,
  minLevel: LoggingLevel = 'debug'
): void {
  if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[minLevel]) {
    return;
  }
  if (!server || !canSendMcpLogs(server)) {
    if (
      level === 'error' ||
      level === 'critical' ||
      level === 'alert' ||
      level === 'emergency'
    ) {
      console.error(`[${level.toUpperCase()}] ${data}`);
    } else if (level === 'warning') {
      console.warn(`[${level.toUpperCase()}] ${data}`);
    } else {
      console.log(`[${level.toUpperCase()}] ${data}`);
    }
    return;
  }

  const params: LoggingMessageNotificationParams = {
    level,
    logger: MCP_LOGGER_NAME,
    data,
  };

  void server.sendLoggingMessage(params).catch((error: unknown) => {
    console.error(
      `Failed to send MCP log: ${level} | ${data}`,
      formatUnknownErrorMessage(error)
    );
  });
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

channel('filesystem-mcp:log').subscribe((message) => {
  const event = message as LogEvent;
  const target = event.sessionId
    ? activeServers.get(event.sessionId)
    : stdioServer;
  if (target) {
    const dataStr = event.data
      ? ` ${typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}`
      : '';
    logToMcp(
      target.server,
      event.level,
      `${event.message}${dataStr}`,
      target.loggingState.minimumLevel
    );
  } else {
    // Fallback if no server
    const dataStr = event.data
      ? ` ${typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}`
      : '';
    const fullMsg = `${event.message}${dataStr}`;
    if (
      event.level === 'error' ||
      event.level === 'critical' ||
      event.level === 'alert' ||
      event.level === 'emergency'
    ) {
      console.error(`[${event.level.toUpperCase()}] ${fullMsg}`);
    } else if (event.level === 'warning') {
      console.warn(`[${event.level.toUpperCase()}] ${fullMsg}`);
    } else {
      console.log(`[${event.level.toUpperCase()}] ${fullMsg}`);
    }
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
      const buffer = await fs.readFile(iconPath);
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
    serverConfig.taskStore = new InMemoryTaskStore();
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

async function readRequestBody(req: http.IncomingMessage): Promise<unknown> {
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
  res: http.ServerResponse,
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

function getSessionId(req: http.IncomingMessage): string | undefined {
  const rawSessionId = req.headers['mcp-session-id'];
  return typeof rawSessionId === 'string' &&
    rawSessionId.length <= MAX_SESSION_ID_LENGTH
    ? rawSessionId
    : undefined;
}

function getProtocolVersionHeader(
  req: http.IncomingMessage
): string | undefined {
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
  req: http.IncomingMessage,
  res: http.ServerResponse,
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

function writeUnauthorizedResponse(res: http.ServerResponse): void {
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
  req: http.IncomingMessage,
  res: http.ServerResponse
): boolean {
  const apiKey = process.env['FILESYSTEM_MCP_API_KEY'];
  if (!apiKey) return true;
  if (isAuthorizedBearer(apiKey, req.headers['authorization'])) return true;
  writeUnauthorizedResponse(res);
  return false;
}

function discardRequestBody(req: http.IncomingMessage): void {
  req.on('error', () => {
    // Best effort drain to avoid corrupting keep-alive pipelines.
  });
  req.resume();
}

async function handleSessionTransportRequest(
  session: HttpSession,
  req: http.IncomingMessage,
  res: http.ServerResponse,
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
  res: http.ServerResponse
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

export async function startHttpServer(
  port: number,
  options: ServerOptions
): Promise<http.Server> {
  const sessions = new Map<string, HttpSession>();
  const httpHost = process.env['FILESYSTEM_MCP_HTTP_HOST'] ?? '127.0.0.1';
  assertHttpBindingSecurity(httpHost);

  async function handleMcpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const { method } = req;
    const sessionId = getSessionId(req);

    const { origin } = req.headers;
    if (!isAllowedOrigin(origin)) {
      sendJsonRpcError(
        res,
        403,
        JSON_RPC_SERVER_ERROR,
        'Forbidden: disallowed origin'
      );
      return;
    }

    if (!ensureAuthorizedRequest(req, res)) return;

    try {
      if (method === 'POST') {
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
      } else if (method === 'GET' || method === 'DELETE') {
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
      } else {
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
    } catch (error: unknown) {
      if (error instanceof RequestBodyError && !res.headersSent) {
        const rpcCode =
          error.statusCode === 413
            ? JSON_RPC_INVALID_REQUEST
            : JSON_RPC_PARSE_ERROR;
        res.setHeader('Connection', 'close');
        sendJsonRpcError(res, error.statusCode, rpcCode, error.message);
        return;
      }
      console.error(
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
  }

  const httpServer = http.createServer(
    (req: http.IncomingMessage, res: http.ServerResponse) => {
      const urlPath = (req.url ?? '/').split('?')[0];
      if (urlPath === '/mcp') {
        handleMcpRequest(req, res).catch((err: unknown) => {
          console.error(
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

  return new Promise<http.Server>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, httpHost, () => {
      Logger.error(`MCP HTTP server listening on ${httpHost}:${port}`);
      resolve(httpServer);
    });
  });
}
