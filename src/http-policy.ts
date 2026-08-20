import { createHash, timingSafeEqual } from 'node:crypto';

import { ErrorCode, FsError } from './core/errors.js';

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

export function isSecureApiKey(key: string | undefined): boolean {
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
