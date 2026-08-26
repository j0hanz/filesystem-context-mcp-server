// Pieces both transport legs share: the runtime config contract and the
// `subscriptions/listen` watcher-preparation ladder. stdio and HTTP gate the
// same message shape; only where the lease is released differs (connection
// close vs response close).
import type { ServerEventBus } from '@modelcontextprotocol/server';

import { formatUnknownErrorMessage } from '../core/errors.js';
import type { PathGuard } from '../core/path.js';
import {
  MAX_WATCHERS,
  type WatcherAttachResult,
  type WatcherRegistry,
} from '../core/watcher-registry.js';

/**
 * Runtime inputs the CLI resolves once (flag, else the operator's env var) and
 * hands the transport. Separate from `ServerOptions` because that object is
 * `PathGuard`'s constructor argument: the filesystem guard has no use for a
 * bind address and no business holding a bearer secret.
 */
export interface RuntimeConfig {
  /** `--http-host` or `HTTP_HOST`. The HTTP bind defaults to loopback without it. */
  httpHost?: string;
  /** `--api-key` or `API_KEY`. Unset means open access (loopback dev mode). */
  apiKey?: string;
  /** Shared change-event bus for multi-instance HTTP deployments. Caller-owned. */
  eventBus?: ServerEventBus;
}

/** The request id of a parsed JSON-RPC body, for error-envelope echo. */
export function jsonRpcRequestId(parsedBody: unknown): string | number | null {
  const id = (parsedBody as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/** The `resourceSubscriptions` URIs of a `subscriptions/listen` body, de-duplicated. */
export function listenSubscriptionUris(parsedBody: unknown): string[] {
  if (typeof parsedBody !== 'object' || parsedBody === null) return [];
  const body = parsedBody as {
    method?: unknown;
    params?: { notifications?: { resourceSubscriptions?: unknown } };
  };
  if (body.method !== 'subscriptions/listen') return [];
  const uris = body.params?.notifications?.resourceSubscriptions;
  if (!Array.isArray(uris)) return [];
  // De-duplicate: one attach must yield one ref-count, or the release below
  // decrements further than it incremented and tears down a live watcher.
  return [...new Set(uris.filter((uri): uri is string => typeof uri === 'string'))];
}

export type ListenPreparation =
  | { readonly ok: true; readonly acquiredUris: string[] }
  | { readonly ok: false; readonly message: string };

const WATCHER_FAILURE_REASONS = {
  'bad-uri': 'unsupported resource URI',
  capped: `watcher limit ${MAX_WATCHERS} reached`,
  'attach-failed': 'filesystem watcher could not be created',
  stale: 'subscription was cancelled during setup',
} as const;

function watcherFailureMessage(
  uri: string,
  result: Exclude<WatcherAttachResult, { ok: true }>,
): string {
  const why =
    result.reason === 'invalid-path'
      ? formatUnknownErrorMessage(result.error)
      : WATCHER_FAILURE_REASONS[result.reason];
  return `Cannot subscribe to ${uri}: ${why}`;
}

/**
 * Prepare every filesystem watcher named by a `subscriptions/listen` filter.
 * The batch is all-or-nothing: a failed URI releases each prior lease.
 */
export async function prepareListenWatchers(
  parsedBody: unknown,
  pathGuard: PathGuard,
  registry: WatcherRegistry,
  notify: (uri: string) => void,
): Promise<ListenPreparation> {
  const uris = listenSubscriptionUris(parsedBody);
  const acquired: string[] = [];
  for (const uri of uris) {
    const result = await registry.acquire(pathGuard, uri, notify);
    if (!result.ok) {
      for (const prior of acquired) registry.release(prior);
      return { ok: false, message: watcherFailureMessage(uri, result) };
    }
    acquired.push(uri);
  }
  return { ok: true, acquiredUris: acquired };
}
