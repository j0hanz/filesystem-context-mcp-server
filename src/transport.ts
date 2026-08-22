import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import {
  createMcpHandler,
  DEFAULT_REQUEST_TIMEOUT_MSEC,
  InMemoryServerEventBus,
  JSONRPC_VERSION,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import type { Server } from 'node:http';
import { createServer as createHttpServer } from 'node:http';

import type { Express, NextFunction, Request, Response } from 'express';

import { formatUnknownErrorMessage } from './core/errors.js';
import { Logger } from './core/observability.js';
import { PathGuard } from './core/path.js';
import type { ServerOptions } from './core/path.js';
import type { ServerNotifier } from './core/registrar.js';
import { MIB, parseEnvInt } from './core/util.js';
import { createWatcherRegistry, type WatcherRegistry } from './core/watcher-registry.js';
import {
  assertHttpBindingPolicy,
  assertHttpHostPolicy,
  bearerAuthMiddleware,
  computeAllowedOriginHostnames,
  corsPreflightHandler,
  createRateLimiter,
  protectedResourceUrl,
  resolveAllowedHosts,
  resolveTrustProxySetting,
} from './http-policy.js';
import { attachFileWatcherForUri } from './resources.js';
import type { FilesystemServerContext } from './server.js';
import { createServer } from './server.js';

// ═══════════════════════════════════════════════════════════════
// stdio
// ═══════════════════════════════════════════════════════════════

/**
 * Serve filesystem-mcp over stdio using modern protocol revision 2026-07-28.
 */
export function startServer(options: ServerOptions): StdioServerHandle {
  let activeCtx: FilesystemServerContext | undefined;
  const factory: McpServerFactory = async () => {
    const c = await createServer(options);
    activeCtx = c;
    return c.mcp;
  };

  const handle = serveStdio(factory, {
    legacy: 'serve',
    onerror: (error: unknown) => {
      Logger.error('[Stdio] serve error:', formatUnknownErrorMessage(error));
    },
  });

  return {
    close: async () => {
      try {
        activeCtx?.disposeRuntimeState();
      } catch {
        /* idempotent — disposeRuntimeState guards cleanedUp */
      }
      activeCtx = undefined;
      await handle.close();
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// http
// ═══════════════════════════════════════════════════════════════

const MAX_REQUEST_BODY_BYTES = parseEnvInt(
  'FS_CONTEXT_MAX_REQUEST_BYTES',
  4 * MIB,
  1024,
  256 * MIB,
);

function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: JSONRPC_VERSION,
    id: null,
    error: { code, message },
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

/**
 * Attach filesystem watchers for the URIs named in a `subscriptions/listen`
 * filter.
 */
async function attachListenWatchers(
  parsedBody: unknown,
  pathGuard: PathGuard,
  registry: WatcherRegistry,
  bus: InMemoryServerEventBus,
): Promise<void> {
  if (typeof parsedBody !== 'object' || parsedBody === null) return;
  const body = parsedBody as {
    method?: unknown;
    params?: { notifications?: { resourceSubscriptions?: unknown } };
  };
  if (body.method !== 'subscriptions/listen') return;
  const uris = body.params?.notifications?.resourceSubscriptions;
  if (!Array.isArray(uris)) return;
  const sink = (uri: string): void => {
    bus.publish({ kind: 'resource_updated', uri });
  };
  for (const uri of uris) {
    if (typeof uri !== 'string') continue;
    try {
      await attachFileWatcherForUri(registry, pathGuard, uri, sink);
    } catch (err: unknown) {
      Logger.warn(
        `[HTTP] listen watcher attach failed for ${uri}:`,
        formatUnknownErrorMessage(err),
      );
    }
  }
}

function createServerNotifier(bus: InMemoryServerEventBus): ServerNotifier {
  return {
    toolsChanged: () => {
      bus.publish({ kind: 'tools_list_changed' });
    },
    promptsChanged: () => {
      bus.publish({ kind: 'prompts_list_changed' });
    },
    resourcesChanged: () => {
      bus.publish({ kind: 'resources_list_changed' });
    },
    resourceUpdated: (uri: string) => {
      bus.publish({ kind: 'resource_updated', uri });
    },
  };
}

function makeHttpModernFactory(
  options: ServerOptions,
  bus: InMemoryServerEventBus,
  sharedRegistry: WatcherRegistry,
): McpServerFactory {
  const notifier = createServerNotifier(bus);
  return async () => {
    const c = await createServer(options, {
      watcherRegistry: sharedRegistry,
      notifier,
    });
    const previousOnClose = c.mcp.server.onclose;
    c.mcp.server.onclose = () => {
      previousOnClose?.();
      c.disposeRuntimeState();
    };
    return c.mcp;
  };
}

function setupExpressApp(
  httpHost: string,
  apiKey: string | undefined,
  allowedHosts: string[],
  modernNodeHandler: (req: Request, res: Response, parsedBody?: unknown) => Promise<void>,
  watcherPathGuard: PathGuard,
  sharedRegistry: WatcherRegistry,
  bus: InMemoryServerEventBus,
): Express {
  const allowedOriginHostnames = computeAllowedOriginHostnames(
    process.env['FILESYSTEM_MCP_ALLOWED_ORIGINS'],
  );

  const app = createMcpExpressApp({
    host: httpHost,
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    ...(allowedOriginHostnames.length > 0 ? { allowedOrigins: allowedOriginHostnames } : {}),
    jsonLimit: `${MAX_REQUEST_BODY_BYTES}b`,
  });

  const trustProxy = resolveTrustProxySetting(process.env['FILESYSTEM_MCP_TRUST_PROXY']);
  if (trustProxy !== undefined) {
    app.set('trust proxy', trustProxy);
  }

  if (allowedHosts.length === 0) {
    Logger.warn(
      '[HTTP] FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS is set: binding globally without Host validation.',
    );
  }

  app.options('/mcp', corsPreflightHandler(allowedOriginHostnames));

  if (apiKey) {
    const rpm = parseEnvInt('FILESYSTEM_MCP_RATE_LIMIT_RPM', 120, 1, 100_000);
    app.use('/mcp', createRateLimiter(rpm));
  }

  if (apiKey) {
    const metadataHandler = (req: Request, res: Response): void => {
      const resource = protectedResourceUrl(req, allowedHosts.length > 0);
      if (!resource) {
        sendJsonRpcError(
          res,
          400,
          ProtocolErrorCode.InvalidRequest,
          'Cannot derive a resource identifier from the Host header. Set FILESYSTEM_MCP_PUBLIC_URL.',
        );
        return;
      }
      res.header('Access-Control-Allow-Origin', '*');
      res.status(200).json({
        resource: resource.href,
        bearer_methods_supported: ['header'],
        resource_name: 'filesystem-mcp',
      });
    };
    app.get(
      ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
      metadataHandler,
    );
  }

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
    });
  });

  app.use('/mcp', bearerAuthMiddleware(apiKey, allowedHosts.length > 0));

  app.post('/mcp', (req: Request, res: Response, next: NextFunction) => {
    const parsedBody = req.body as unknown;
    // Best-effort: fire-and-forget so a watcher error never blocks the request.
    void attachListenWatchers(parsedBody, watcherPathGuard, sharedRegistry, bus).catch(
      (err: unknown) => {
        Logger.warn('[HTTP] listen watcher attach error:', formatUnknownErrorMessage(err));
      },
    );
    modernNodeHandler(req, res, parsedBody).catch(next);
  });

  app.all('/mcp', (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'POST, OPTIONS').end();
  });

  app.use(errorHandlerMiddleware);

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
  const allowedHosts = resolveAllowedHosts(httpHost, process.env['FILESYSTEM_MCP_ALLOWED_HOSTS']);
  assertHttpHostPolicy(
    httpHost,
    allowedHosts,
    process.env['FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS'] === '1',
  );

  const bus = new InMemoryServerEventBus();
  const sharedRegistry = createWatcherRegistry();
  const watcherPathGuard = new PathGuard(options, true);
  await watcherPathGuard.recomputeAllowedDirectories();

  const modernHandler = createMcpHandler(makeHttpModernFactory(options, bus, sharedRegistry), {
    legacy: 'reject',
    bus,
    onerror: (error: Error) => {
      Logger.error('[HTTP] modern leg error:', formatUnknownErrorMessage(error));
    },
  });
  const modernNodeHandler = toNodeHandler(modernHandler);

  const app = setupExpressApp(
    httpHost,
    apiKey,
    allowedHosts,
    modernNodeHandler,
    watcherPathGuard,
    sharedRegistry,
    bus,
  );

  const httpServer = createHttpServer(app);
  httpServer.headersTimeout = 10_000;
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

  const originalClose = httpServer.close.bind(httpServer);
  httpServer.close = function (callback?: (error?: Error) => void) {
    sharedRegistry.destroy();
    modernHandler
      .close()
      .then(() => {
        originalClose(callback);
      })
      .catch((err: unknown) => {
        Logger.error(
          '[HTTP] Error closing handler during HTTP server close:',
          formatUnknownErrorMessage(err),
        );
        originalClose(callback);
      });
    return httpServer;
  };

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      sharedRegistry.destroy();
      modernHandler.close().catch((closeErr: unknown) => {
        Logger.error(
          '[HTTP] Error closing handler on startup failure:',
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
