import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/express';
import { localhostAllowedHostnames } from '@modelcontextprotocol/server';

import { createHash, timingSafeEqual } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { ErrorCode, FsError } from './core/errors.js';
import { Logger } from './core/observability.js';

const MAX_BEARER_TOKEN_LENGTH = 4096;

const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u;

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
  return LOCALHOST_ORIGIN_RE.test(origin);
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
 * Splits `FILESYSTEM_MCP_ALLOWED_HOSTS` into trimmed, non-empty hostnames.
 * Empty entries are dropped so a value of "," or " " reads as unset rather than
 * as a list that rejects every Host. Shared by the binding policy and the app
 * wiring so both agree on what "configured" means.
 */
export function parseAllowedHostsEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
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
  if (parseAllowedHostsEnv(allowedHostsEnv).length > 0) return;
  throw new FsError(
    ErrorCode.PERMISSION_DENIED,
    `Refusing to bind wildcard host '${host}' without FILESYSTEM_MCP_ALLOWED_HOSTS. Set it to the public hostname(s) clients send, or set FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS=1 to accept the risk.`,
  );
}

// ─── Protected-resource discovery (RFC 9728 / RFC 6750) ──────────────────────

/**
 * This server is a resource server with no authorization server: `API_KEY` is a
 * static secret the operator hands out of band, not an issued token. So the
 * metadata document deliberately omits `authorization_servers` — RFC 9728 §2
 * makes it optional, and its absence is the accurate statement that a token
 * cannot be obtained from an endpoint. `mcpAuthMetadataRouter` from
 * `@modelcontextprotocol/express` is the tool for the IdP-backed case: it
 * requires RFC 8414 authorization-server metadata, and inventing an issuer with
 * endpoints that answer nothing would send clients into a flow that cannot
 * complete. Adopt it if this ever moves to a real IdP.
 *
 * What discovery buys here: a client hitting 401 learns the resource identifier
 * and that the credential goes in the Authorization header, instead of a bare
 * challenge plus a 404 on the well-known path.
 */
export function protectedResourceUrl(req: Request): URL | null {
  const configured = process.env['FILESYSTEM_MCP_PUBLIC_URL'];
  if (configured) {
    const parsed = URL.parse(configured);
    if (parsed) return parsed;
    Logger.warn(
      `[HTTP] Ignoring unparseable FILESYSTEM_MCP_PUBLIC_URL: ${configured}. Deriving the resource identifier from the Host header instead.`,
    );
  }
  // Raw client input. The app's allowedHosts check constrains it ONLY when an
  // allowlist is configured — a wildcard bind under
  // FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS=1 computes an empty list, and the
  // SDK mounts its Host validator conditionally on that list being non-empty.
  // So this parse can fail (a space or `%` is not a legal host); null then
  // means callers omit the hint rather than name a resource we invented.
  const host = req.headers.host ?? '127.0.0.1';
  return URL.parse(`${req.secure ? 'https' : 'http'}://${host}/mcp`);
}

/**
 * RFC 6750 §3: a request with no credentials gets a bare challenge, while one
 * that presented something invalid gets `error="invalid_token"`. Clients use
 * the difference to tell "you must authenticate" from "your token is wrong".
 */
function buildAuthChallenge(req: Request, hasCredentials: boolean): string {
  const resource = protectedResourceUrl(req);
  const params: string[] = [];
  if (resource) {
    params.push(`resource_metadata="${getOAuthProtectedResourceMetadataUrl(resource)}"`);
  }
  if (hasCredentials) {
    params.push('error="invalid_token"', 'error_description="Invalid or expired bearer token"');
  }
  // A bare `Bearer` is a complete challenge; avoid emitting a trailing space.
  return params.length > 0 ? `Bearer ${params.join(', ')}` : 'Bearer';
}

/**
 * Express middleware: when `apiKey` is set, require a matching bearer token.
 * No key set = open access (loopback dev mode). `apiKey` is captured once per
 * app setup (passed in from startHttpServer) so the middleware and
 * assertHttpBindingPolicy share one source of truth.
 */
export function bearerAuthMiddleware(apiKey: string | undefined): RequestHandler {
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
      'WWW-Authenticate': buildAuthChallenge(req, req.headers.authorization !== undefined),
    });
    // -32000 is the JSON-RPC server-defined error range; no SDK enum maps to
    // "Unauthorized". The 401 body is inlined with the fixed JSON-RPC 2.0 "2.0"
    // literal so this policy module does not depend on the transport's
    // JSON-RPC wire-shape helpers (sendJsonRpcError), keeping http-policy
    // free of server-runtime concerns.
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Unauthorized' },
      }),
    );
  };
}

/**
 * Env-derived CORS origins (hostname-form, no scheme/port — matches the SDK
 * app's `allowedOrigins` consumer). Defaults to the SDK's loopback hostname set
 * so loopback browser clients keep working; operators set
 * `FILESYSTEM_MCP_ALLOWED_ORIGINS` to allow remote clients on non-loopback
 * binds. An empty value reads as unset, matching how parseAllowedHostsEnv
 * treats an all-empty list. The same set is consulted by corsPreflightHandler
 * so a remote origin is reflected end-to-end in Access-Control-Allow-Origin.
 */
export function computeAllowedOriginHostnames(originsEnv: string | undefined): string[] {
  return originsEnv
    ? originsEnv
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : localhostAllowedHostnames();
}

/**
 * OPTIONS preflight for `/mcp`: reflect a present Origin if it is allowed —
 * localhost, or in the env-derived `FILESYSTEM_MCP_ALLOWED_ORIGINS` set — and
 * avoid emitting a wildcard fallback.
 */
export function corsPreflightHandler(allowedOriginHostnames: readonly string[]): RequestHandler {
  return (req: Request, res: Response): void => {
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
  };
}

// ─── Rate limiting (public bind only) ────────────────────────────────────────

interface RateBucket {
  windowStart: number;
  count: number;
}

// Fixed 60s window; never tuned, so it is a constant rather than config plumbing.
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Fixed-window per-client-IP rate limiter.
 */
export function createRateLimiter(max: number): RequestHandler {
  const buckets = new Map<string, RateBucket>();
  const sweep = setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
    for (const [ip, bucket] of buckets) {
      if (bucket.windowStart < cutoff) buckets.delete(ip);
    }
  }, RATE_LIMIT_WINDOW_MS);
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
      bucket = { windowStart: now, count: 0 };
      buckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count <= max) {
      next();
      return;
    }
    const retryAfterSec = Math.max(
      1,
      Math.ceil((bucket.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000),
    );
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfterSec),
    });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Rate limit exceeded' },
      }),
    );
  };
}
