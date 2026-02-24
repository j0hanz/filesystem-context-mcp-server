import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
} from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  isInitializeRequest,
  SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { registerCompletions } from '../completions.js';
import { DEFAULT_LOG_LEVEL } from '../lib/constants.js';
import { formatUnknownErrorMessage } from '../lib/errors.js';
import { createInMemoryResourceStore } from '../lib/resource-store.js';
import { pkgInfo } from '../pkg-info.js';
import { registerGetHelpPrompt } from '../prompts.js';
import {
  registerInstructionResource,
  registerMetricsResource,
  registerResultResources,
  registerToolCatalogResource,
  registerWorkflowGuideResource,
} from '../resources.js';
import { buildServerInstructions } from '../resources/generated-instructions.js';
import { registerAllTools } from '../tools.js';
import type { IconInfo } from '../tools/shared.js';
import { withDefaultIcons } from '../tools/shared.js';
import {
  buildServerCapabilities,
  supportsTaskToolRequests,
} from './capabilities.js';
import { createLoggingState } from './logging.js';
import { RootsManager } from './roots-manager.js';
import type { ServerOptions } from './types.js';

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
    serverConfig.taskStore = new InMemoryTaskStore();
    serverConfig.taskMessageQueue = new InMemoryTaskMessageQueue();
  }

  if (serverInstructions) {
    serverConfig.instructions =
      'filesystem-mcp: Secure local filesystem MCP server. ' +
      'Always begin with: roots → ls/find → stat → read. Never guess paths. ' +
      'Full reference: read the internal://instructions resource or invoke the get-help prompt.';
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

  server.server.setRequestHandler(SetLevelRequestSchema, (req) => {
    loggingState.minimumLevel = req.params.level;
    return {};
  });

  registerInstructionResource(server, serverInstructions, localIcon);
  registerToolCatalogResource(server, localIcon);
  registerWorkflowGuideResource(server, localIcon);
  registerGetHelpPrompt(server, serverInstructions, localIcon);
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

  const transportAny = transport as { onclose?: (() => void) | undefined };
  const sdkOnClose = transportAny.onclose;
  transportAny.onclose = () => {
    rootsManager.destroy();
    sdkOnClose?.();
  };

  rootsManager.logMissingDirectoriesIfNeeded(server);
}

const MAX_REQUEST_BODY_BYTES =
  parseInt(process.env['FS_CONTEXT_MAX_REQUEST_BYTES'] ?? '', 10) ||
  4 * 1024 * 1024; // 4 MB default

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
  transport: StreamableHTTPServerTransport;
}

async function createHttpSession(
  options: ServerOptions,
  sessions: Map<string, HttpSession>
): Promise<{ server: McpServer; transport: StreamableHTTPServerTransport }> {
  const mcpServer = await createServer(options);
  const rootsManager = getRootsManager(mcpServer);

  rootsManager.registerHandlers(mcpServer);
  await rootsManager.recomputeAllowedDirectories();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, { server: mcpServer, transport });
      rootsManager.logMissingDirectoriesIfNeeded(mcpServer);
    },
    onsessionclosed: (sessionId) => {
      sessions.delete(sessionId);
    },
  });

  transport.onclose = () => {
    const { sessionId } = transport;
    if (sessionId) {
      sessions.delete(sessionId);
    }
    rootsManager.destroy();
    mcpServer.close().catch((err: unknown) => {
      console.error(
        '[HTTP] Error closing MCP server:',
        formatUnknownErrorMessage(err)
      );
    });
  };

  await mcpServer.connect(transport as unknown as Transport);

  return { server: mcpServer, transport };
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

function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true; // Non-browser clients omit Origin.
  return LOCALHOST_ORIGIN_RE.test(origin);
}

export async function startHttpServer(
  port: number,
  options: ServerOptions
): Promise<http.Server> {
  const sessions = new Map<string, HttpSession>();

  async function handleMcpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const { method } = req;
    const MAX_SESSION_ID_LENGTH = 256;
    const rawSessionId = req.headers['mcp-session-id'];
    const sessionId =
      typeof rawSessionId === 'string' &&
      rawSessionId.length <= MAX_SESSION_ID_LENGTH
        ? rawSessionId
        : undefined;

    const { origin } = req.headers;
    if (!isAllowedOrigin(origin)) {
      sendJsonRpcError(res, 403, -32000, 'Forbidden: disallowed origin');
      return;
    }

    const apiKey = process.env['FILESYSTEM_MCP_API_KEY'];
    if (apiKey) {
      const authHeader = req.headers['authorization'];
      const bearerPrefix = 'Bearer ';
      let authorized = false;
      if (
        typeof authHeader === 'string' &&
        authHeader.startsWith(bearerPrefix)
      ) {
        const userKey = authHeader.slice(bearerPrefix.length);
        const expectedHash = createHash('sha256').update(apiKey).digest();
        const actualHash = createHash('sha256').update(userKey).digest();
        authorized = timingSafeEqual(expectedHash, actualHash);
      }
      if (!authorized) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer',
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Unauthorized' },
            id: null,
          })
        );
        return;
      }
    }

    try {
      if (method === 'POST') {
        const body = await readRequestBody(req);

        if (sessionId && sessions.has(sessionId)) {
          const protoVersion = req.headers['mcp-protocol-version'];
          if (protoVersion !== '2025-11-25') {
            console.error(
              '[mcp-http] MCP-Protocol-Version header missing or unsupported:',
              protoVersion
            );
          }
          const session = sessions.get(sessionId);
          if (session) {
            await session.transport.handleRequest(req, res, body);
          }
        } else if (!sessionId && isInitializeRequest(body)) {
          const { transport } = await createHttpSession(options, sessions);
          await transport.handleRequest(req, res, body);
        } else if (sessionId) {
          sendJsonRpcError(res, 400, -32000, 'Bad Request: Session not found');
        } else {
          sendJsonRpcError(
            res,
            400,
            -32000,
            'Bad Request: No valid session ID provided'
          );
        }
      } else if (method === 'GET' || method === 'DELETE') {
        if (!sessionId || !sessions.has(sessionId)) {
          sendJsonRpcError(
            res,
            400,
            -32000,
            'Bad Request: Invalid or missing session ID'
          );
          return;
        }
        const session = sessions.get(sessionId);
        if (session) {
          await session.transport.handleRequest(req, res);
        }
      } else {
        res.writeHead(405, { Allow: 'GET, POST, DELETE' });
        res.end('Method Not Allowed');
      }
    } catch (error: unknown) {
      if (error instanceof RequestBodyError && !res.headersSent) {
        const rpcCode = error.statusCode === 413 ? -32600 : -32700;
        res.setHeader('Connection', 'close');
        sendJsonRpcError(res, error.statusCode, rpcCode, error.message);
        return;
      }
      console.error(
        '[HTTP] Error handling request:',
        formatUnknownErrorMessage(error)
      );
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, 'Internal Server Error');
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

  // Default to localhost-only binding to prevent DNS-rebinding and unintended
  // external exposure. Override with FILESYSTEM_MCP_HTTP_HOST for remote setups.
  const httpHost = process.env['FILESYSTEM_MCP_HTTP_HOST'] ?? '127.0.0.1';

  return new Promise<http.Server>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, httpHost, () => {
      console.error(`MCP HTTP server listening on ${httpHost}:${port}`);
      resolve(httpServer);
    });
  });
}
