import type {
  CacheHint,
  McpServer,
  ReadResourceResult,
  Resource,
  ResourceUpdatedNotificationParams,
  Role,
  ServerContext,
  ServerNotifier,
  SubscribeRequestParams,
  UnsubscribeRequestParams,
} from '@modelcontextprotocol/server';
import {
  checkResourceAllowed,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  resourceUrlFromServerUrl,
  UriTemplate,
} from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import type { FsError } from './core/errors.js';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  fsErrorCode,
  hasErrorShape,
  isFsError,
} from './core/errors.js';
import {
  buildFileResourceUri,
  extractPath,
  FILESYSTEM_FILE_URI_TEMPLATE,
} from './core/file-uri.js';
import { GuardedFileSystem } from './core/fs.js';
import { Logger } from './core/observability.js';
import { PathCompleter } from './core/path-completer.js';
import type { PathGuard } from './core/path.js';
import type { ResourceStore } from './core/store.js';
import {
  createWatcherRegistry,
  MAX_WATCHERS,
  type WatcherRegistry,
} from './core/watcher-registry.js';
import { buildSectionsRecord, INSTRUCTIONS_URI, renderSections } from './instructions.js';

// ═══════════════════════════════════════════════════════════════
// shared
// ═══════════════════════════════════════════════════════════════

export interface ResourceRegistrationOptions {
  resourceStore: ResourceStore;
  pathGuard?: PathGuard;
  /** Mirrors the `--read-only` gate so the instructions match the tools actually registered. */
  readOnly: boolean;
  /**
   * Shared file-watcher registry for the modern (per-request) HTTP leg. When set,
   * the resource uses this handler-scoped registry instead of creating its own
   * per-server one, so file-change watchers persist across requests and publish
   * to the shared ServerEventBus. Omitted (per-server registry) on legacy/stdio.
   */
  watcherRegistry?: WatcherRegistry;
  /** Modern-leg typed notification publisher. */
  notifier?: ServerNotifier;
  /** The protocol era this instance serves; omitted where the caller does not know. */
  era?: 'legacy' | 'modern';
}

type ResourceRegistrarDeps = Omit<ResourceRegistrationOptions, 'pathGuard' | 'readOnly'> & {
  readonly server: McpServer;
  readonly pathGuard: PathGuard;
  readonly readOnly?: boolean;
};

/**
 * A filesystem failure that reads as not-found on the resource wire, for both
 * `resources/read` and `resources/subscribe`. ACCESS_DENIED folds in
 * deliberately: masking whether an out-of-root or denylisted path exists is the
 * security-correct answer, and the `FsError` message still carries the real
 * cause to the client.
 */
function isNotFoundish(error: unknown): error is FsError {
  return (
    isFsError(error) &&
    (error.code === ErrorCode.NOT_FOUND || error.code === ErrorCode.ACCESS_DENIED)
  );
}

// ═══════════════════════════════════════════════════════════════
// contract
// ═══════════════════════════════════════════════════════════════

interface BaseResourceContract {
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  cacheHint?: CacheHint;
  annotations?: {
    audience?: Role[];
    priority?: number;
  };
  readonly read: (
    uri: URL,
    variables: Record<string, string | string[]>,
    ctx: ServerContext,
  ) => Promise<ReadResourceResult> | ReadResourceResult;
  readonly subscribe?: (
    uri: string,
    notify: (uri: string) => void,
  ) => Promise<boolean | undefined> | boolean | undefined;
  readonly unsubscribe?: (uri: string) => void;
  readonly destroy?: () => void;
  readonly list?: (
    ctx: ServerContext,
  ) => Promise<{ resources: Resource[] }> | { resources: Resource[] };
}

/** A resource with a fixed, enumerable URI (e.g. internal://instructions). */
interface StaticResourceContract extends BaseResourceContract {
  uri: string;
  uriTemplate?: never;
  complete?: never;
}

/** A resource identified by a URI template (FILESYSTEM_FILE_URI_TEMPLATE). */
interface TemplateResourceContract extends BaseResourceContract {
  uriTemplate: string;
  uri?: never;
  complete?: (
    variable: string,
    value: string,
    ctx?: { arguments?: Record<string, string> },
  ) => Promise<string[]> | string[];
}

type ResourceContract = StaticResourceContract | TemplateResourceContract;

// ═══════════════════════════════════════════════════════════════
// instructions
// ═══════════════════════════════════════════════════════════════

function createInstructionsResource(options: ResourceRegistrationOptions): ResourceContract {
  const text = renderSections(buildSectionsRecord(options.readOnly));
  return {
    name: 'filesystem-mcp-instructions',
    title: 'Server Instructions',
    description: 'Navigation guide for filesystem-mcp tools and constraints.',
    mimeType: 'text/markdown',
    uri: INSTRUCTIONS_URI,
    annotations: { audience: ['assistant'], priority: 0.8 },
    cacheHint: { cacheScope: 'public', ttlMs: 300_000 },
    read(uri) {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text,
          },
        ],
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// filesystem
// ═══════════════════════════════════════════════════════════════

function warnWatcherCap(uri: string): void {
  Logger.warn(`Cannot subscribe to ${uri}: MAX_WATCHERS limit (${MAX_WATCHERS}) reached.`);
}

/**
 * `ok` means a watcher is live for this uri and `notify` is registered. Every
 * other outcome names why, and only `invalid-path` carries what
 * `validateExistingPath` threw — so `error` is unreachable on a branch that has
 * none.
 */
export type WatcherAttachResult =
  | { ok: true }
  | { ok: false; reason: 'stale' | 'capped' | 'bad-uri' | 'attach-failed' }
  | { ok: false; reason: 'invalid-path'; error: unknown };

/**
 * The one attach ladder both watcher entry points run: `resources/subscribe`
 * (2025 era) and the `subscriptions/listen` filter (modern era, HTTP and
 * stdio). Never throws — it reports the outcome and lets each caller decide
 * what that is worth: subscribe owes its caller a precise error, and listen
 * (`prepareListenWatchers`) treats the batch as all-or-nothing, releasing every
 * lease it already took and rejecting the request. Idempotent per URI — a
 * second call for an already-watched URI re-registers the notify callback (one
 * watcher per URI).
 *
 * `markSubscribe` is the one branch that differs: only `resources/subscribe`
 * declares desired state (what `isStale` aborts against). The listen path must
 * not, or a rejected attach past that point strands a `'subscribing'` entry
 * nothing settles. Whoever declares it, this function settles it: every failing
 * exit past that point cancels the declaration, so no uri is poisoned for a
 * later attach.
 *
 * Every `ok` return takes one lease; lifetime is the caller's to manage, and
 * the legs differ. HTTP releases per stream: the listen stream is the POST's
 * own SSE response, so `transport.ts` calls `registry.release` for each URI
 * this returned `ok` for when that response closes (the registry ref-counts by
 * URI, so a watcher another stream still holds survives). Stdio has no
 * per-stream close hook on the SDK's listen router, so its watchers live for
 * the connection and are freed by the shared registry's `destroy()` at close;
 * that is bounded by MAX_WATCHERS, and a stdio connection has exactly one
 * client.
 */
export async function attachFileWatcherForUri(
  registry: WatcherRegistry,
  pathGuard: PathGuard,
  uri: string,
  notify: (uri: string) => void,
  { markSubscribe = false }: { markSubscribe?: boolean } = {},
): Promise<WatcherAttachResult> {
  // Every failing exit below routes through here, so the declaration made by
  // `startSubscribe` can never outlive the attach that made it.
  const fail = (result: WatcherAttachResult & { ok: false }): WatcherAttachResult => {
    if (markSubscribe) registry.cancelSubscribe(uri);
    return result;
  };

  if (registry.hasWatcher(uri)) {
    // A watcher already tracks this uri; just (re)register the callback so its
    // change events reach the new subscriber. No validation or cap work is
    // needed for an already-live watcher.
    registry.addCallback(uri, notify);
    registry.retain(uri);
    return { ok: true };
  }
  // A cap hit before validation and one found after the await are the same
  // condition, and both are reported the same way.
  if (registry.isAtCap()) {
    warnWatcherCap(uri);
    return { ok: false, reason: 'capped' };
  }

  if (markSubscribe) registry.startSubscribe(uri);

  const filePath = extractPath(uri);
  if (!filePath) return fail({ ok: false, reason: 'bad-uri' });

  let resolved: string;
  try {
    resolved = await pathGuard.validateExistingPath(filePath);
  } catch (error: unknown) {
    return fail({ ok: false, reason: 'invalid-path', error });
  }

  // Re-check what the await could have changed. A stale uri is the one failure
  // that must NOT cancel: an unsubscribe landed mid-await and its
  // 'unsubscribed' marker is the thing that aborted this attach.
  if (registry.isStale(uri)) return { ok: false, reason: 'stale' };
  if (registry.hasWatcher(uri)) {
    registry.addCallback(uri, notify);
    registry.retain(uri);
    return { ok: true };
  }
  if (registry.isAtCap()) {
    warnWatcherCap(uri);
    return fail({ ok: false, reason: 'capped' });
  }

  registry.addCallback(uri, notify);
  if (!registry.attach(uri, resolved)) {
    // fs.watch threw (inotify exhaustion, or a race deleted the path): roll back
    // so no dangling callback is left believing a watcher exists. No lease was
    // taken yet, so `release` drops the entry outright.
    registry.release(uri);
    return fail({ ok: false, reason: 'attach-failed' });
  }
  registry.retain(uri);
  return { ok: true };
}

function createFilesystemResource(options: ResourceRegistrationOptions): ResourceContract {
  const completer = options.pathGuard ? new PathCompleter(options.pathGuard) : undefined;
  const guardedFs = options.pathGuard ? new GuardedFileSystem(options.pathGuard) : undefined;
  const registry = options.watcherRegistry ?? createWatcherRegistry();
  // Only the per-server (legacy/stdio) registry is owned by this resource and
  // destroyed on dispose; the shared modern-leg registry is owned by the host
  // and torn down at server shutdown.
  const ownsRegistry = options.watcherRegistry === undefined;

  return {
    name: 'filesystem-mcp-file',
    title: 'Workspace File',
    description: 'Read a file from the workspace. Subscribe to get updates when the file changes.',
    uriTemplate: FILESYSTEM_FILE_URI_TEMPLATE,
    annotations: { audience: ['assistant'], priority: 0.8 },

    async list() {
      const allowed = options.pathGuard?.getAllowedDirectories() ?? [];
      const resources: Resource[] = [];
      for (const rootDir of allowed) {
        let lastModified: string | undefined;
        if (guardedFs) {
          try {
            const { stats } = await guardedFs.stat(rootDir);
            lastModified = new Date(stats.mtimeMs).toISOString();
          } catch {
            // ENOENT: root vanished mid-list. Anything else (EACCES, EBUSY): root
            // exists but is unreadable. Either way omit lastModified and keep the
            // entry — list() must not throw for one bad root.
          }
        }
        resources.push({
          uri: buildFileResourceUri(rootDir),
          name: basename(rootDir) || rootDir,
          description: `Workspace root directory: ${rootDir}`,
          mimeType: 'inode/directory',
          ...(lastModified ? { annotations: { lastModified } } : {}),
        });
      }
      return { resources };
    },

    async read(uri, variables, _ctx: ServerContext) {
      if (!options.pathGuard) {
        throw new ProtocolError(ProtocolErrorCode.InternalError, 'PathGuard not configured');
      }
      // Decode via extractPath — the same decoder resources/subscribe uses — so
      // both consumers are symmetric with buildFileResourceUri's encoding. The
      // {+path} template variable arrives still percent-encoded, so validating
      // it directly would treat "c%3A/proj/a.ts" as a literal relative path.
      const rawPath = extractPath(uri.href) ?? variables['path'];
      if (typeof rawPath !== 'string') {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          'Path variable is required and must be a string',
        );
      }
      await options.pathGuard.validateExistingPath(rawPath);
      const fs = new GuardedFileSystem(options.pathGuard);
      const readResult = await fs.readRaw(rawPath);

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: readResult.mimeType || 'application/octet-stream',
            ...(readResult.isBinary
              ? { blob: readResult.content.toString('base64') }
              : { text: readResult.content.toString('utf-8') }),
          },
        ],
      };
    },

    async complete(variable, value) {
      if (variable === 'path' && options.pathGuard) {
        return completer ? completer.suggest(value) : [];
      }
      return [];
    },

    async subscribe(uri, notify) {
      if (!options.pathGuard) return;

      const result = await attachFileWatcherForUri(registry, options.pathGuard, uri, notify, {
        markSubscribe: true,
      });
      if (result.ok) return undefined;

      if (result.reason === 'bad-uri') {
        throw new ResourceNotFoundError(uri, `Cannot subscribe: not a filesystem URI`);
      }
      if (result.reason === 'invalid-path') {
        const err = result.error;
        if (isNotFoundish(err)) {
          throw new ResourceNotFoundError(uri, `Cannot subscribe to ${uri}: ${err.message}`);
        }
        Logger.warn(
          `Unexpected error validating path for watcher ${uri}: ${formatUnknownErrorMessage(err)}`,
        );
        throw err;
      }
      // Unsubscribed (or the registry destroyed) mid-await: the caller already
      // asked for this to stop, so there is nothing to reject.
      if (result.reason === 'stale') return undefined;
      // capped / attach-failed: `false` tells the handler to reject, since
      // undefined would report success with no watcher attached.
      return false;
    },

    unsubscribe(uri) {
      registry.release(uri);
    },

    destroy() {
      if (ownsRegistry) registry.destroy();
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// result
// ═══════════════════════════════════════════════════════════════

function createResultResource(options: ResourceRegistrationOptions): ResourceContract {
  return {
    name: 'filesystem-mcp-result',
    title: 'Cached Tool Result',
    description:
      'Ephemeral cached tool output. Listed via resources/list; entries expire after the cache TTL.',
    mimeType: 'application/json',
    uriTemplate: 'filesystem-mcp://result/{id}',
    annotations: { audience: ['assistant'], priority: 0.3 },
    cacheHint: { cacheScope: 'private', ttlMs: 60_000 },
    list() {
      const store = options.resourceStore;
      const uris = store.keys(); // prunes expired first
      const resources: Resource[] = [];
      for (const uri of uris) {
        try {
          const entry = store.getEntry(uri);
          resources.push({
            uri: entry.uri,
            name: entry.name,
            mimeType: entry.mimeType,
            size: entry.size,
          });
        } catch (err) {
          // An entry may expire between keys() and getEntry; skip it.
          if (isFsError(err) && err.code === ErrorCode.NOT_FOUND) continue;
          throw err;
        }
      }
      // Recent-first: keys() returns insertion order, so the newest is last.
      resources.reverse();
      return { resources };
    },
    read(uri, variables) {
      const { id } = variables;
      if (typeof id !== 'string' || id.length === 0) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          'Malformed result URI: missing {id}. Use the exact resourceUri returned by the tool.',
        );
      }

      let entry;
      try {
        entry = options.resourceStore.getEntry(uri.toString());
      } catch (err) {
        if (isFsError(err) && err.code === ErrorCode.NOT_FOUND) {
          throw new ResourceNotFoundError(
            uri.toString(),
            'Cached result not found or expired. Re-run the tool to regenerate.',
          );
        }
        throw err;
      }
      return {
        contents: [{ uri: entry.uri, mimeType: entry.mimeType, text: entry.text }],
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// export contracts
// ═══════════════════════════════════════════════════════════════

export function getResourceContracts(options: ResourceRegistrationOptions): ResourceContract[] {
  return [
    createInstructionsResource(options),
    createResultResource(options),
    createFilesystemResource(options),
  ];
}

// ═══════════════════════════════════════════════════════════════
// registrar
// ═══════════════════════════════════════════════════════════════

function wrapRead(contract: ResourceContract) {
  return async (uri: URL, variables: Record<string, string | string[]>, ctx: ServerContext) => {
    try {
      return await contract.read(uri, variables, ctx);
    } catch (error) {
      if (hasErrorShape(error, 'ProtocolError')) throw error;
      // A missing or out-of-root path is a not-found, not a malformed request.
      // The SDK puts ResourceNotFoundError on the wire as -32602 with
      // `data.uri`, which is what clients match on; -32002 is the older code
      // they also accept, and this SDK never emits it.
      if (isNotFoundish(error)) {
        throw new ResourceNotFoundError(uri.toString(), error.message);
      }
      // A remaining FsError (NOT_FILE, TOO_LARGE, ...) traces to the
      // caller-supplied URI; anything else is a server-side failure and must
      // not be blamed on the request.
      const msg = isFsError(error) ? error.message : formatUnknownErrorMessage(error);
      throw new ProtocolError(fsErrorCode(error), msg);
    }
  };
}

export function registerResources(deps: ResourceRegistrarDeps): { dispose(): void } {
  const server = deps.server;
  const resourceContracts = getResourceContracts({ ...deps, readOnly: deps.readOnly ?? false });

  for (const contract of resourceContracts) {
    const config = {
      ...(contract.title !== undefined ? { title: contract.title } : {}),
      ...(contract.description !== undefined ? { description: contract.description } : {}),
      ...(contract.mimeType !== undefined ? { mimeType: contract.mimeType } : {}),
      ...(contract.annotations !== undefined ? { annotations: contract.annotations } : {}),
      ...(contract.cacheHint !== undefined ? { cacheHint: contract.cacheHint } : {}),
    };

    if (contract.uriTemplate) {
      const template = new ResourceTemplate(contract.uriTemplate, {
        list: contract.list,
        ...(contract.complete
          ? {
              complete: Object.fromEntries(
                new UriTemplate(contract.uriTemplate).variableNames.map((varName) => [
                  varName,
                  (value: string, ctx?: { arguments?: Record<string, string> }) => {
                    const completeFn = contract.complete;
                    return completeFn ? completeFn(varName, value, ctx) : [];
                  },
                ]),
              ),
            }
          : {}),
      });

      server.registerResource(contract.name, template, config, wrapRead(contract));
    } else if (contract.uri) {
      server.registerResource(contract.name, contract.uri, config, (uri: URL, ctx: ServerContext) =>
        wrapRead(contract)(uri, {}, ctx),
      );
    }
  }

  // `resources/subscribe`/`unsubscribe` are 2025-era-only verbs; a modern
  // server answers `-32601 Method not found` for them, so registering these
  // handlers on a modern-era instance would dispatch to code no request can
  // reach.
  if (deps.era !== 'modern') {
    server.server.assertCanSetRequestHandler('resources/subscribe');
    server.server.assertCanSetRequestHandler('resources/unsubscribe');

    server.server.setRequestHandler(
      'resources/subscribe',
      async (req: { params: SubscribeRequestParams }) => {
        const requestedResource = resourceUrlFromServerUrl(req.params.uri);
        let foundMatch = false;
        for (const contract of resourceContracts) {
          if (!contract.subscribe) continue;
          const configured = contract.uri ?? contract.uriTemplate.split('{')[0];
          if (!configured) continue;
          if (
            checkResourceAllowed({
              requestedResource,
              configuredResource: configured,
            })
          ) {
            foundMatch = true;
            const subscribeResult = await contract.subscribe(
              requestedResource.toString(),
              (updatedUri) => {
                if (deps.notifier) {
                  deps.notifier.resourceUpdated(updatedUri);
                  return;
                }
                const updatePayload: ResourceUpdatedNotificationParams = { uri: updatedUri };
                // A failed notify means the connection went away; nothing to recover.
                void server.server.sendResourceUpdated(updatePayload).catch((err: unknown) => {
                  Logger.debug('resource update not delivered', {
                    uri: updatedUri,
                    error: formatUnknownErrorMessage(err),
                  });
                });
              },
            );
            if (subscribeResult === false) {
              throw new ProtocolError(
                ProtocolErrorCode.InternalError,
                `Subscription rejected: no watcher attached (watcher limit ${MAX_WATCHERS} reached, or fs.watch failed to start).`,
              );
            }
            break;
          }
        }
        if (!foundMatch) {
          throw new ResourceNotFoundError(
            requestedResource.toString(),
            `Resource not found: ${requestedResource.toString()}`,
          );
        }
        return {};
      },
    );

    server.server.setRequestHandler(
      'resources/unsubscribe',
      (req: { params: UnsubscribeRequestParams }) => {
        const canonical = resourceUrlFromServerUrl(req.params.uri).toString();
        for (const contract of resourceContracts) {
          if (contract.unsubscribe) {
            contract.unsubscribe(canonical);
          }
        }
        return {};
      },
    );
  }

  return {
    dispose(): void {
      for (const contract of resourceContracts) {
        if (contract.destroy) {
          contract.destroy();
        }
      }
    },
  };
}
