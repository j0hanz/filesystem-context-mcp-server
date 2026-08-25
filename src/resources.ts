import type {
  CacheHint,
  McpServer,
  ReadResourceResult,
  Resource,
  ResourceUpdatedNotificationParams,
  Role,
  ServerContext,
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

import { ErrorCode, formatUnknownErrorMessage, hasErrorShape, isFsError } from './core/errors.js';
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
import type { ServerDeps, ServerNotifier } from './server.js';

// ═══════════════════════════════════════════════════════════════
// shared
// ═══════════════════════════════════════════════════════════════

export interface ResourceRegistrationOptions {
  resourceStore: ResourceStore;
  pathGuard?: PathGuard;
  server?: McpServer;
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
 * Best-effort filesystem-watcher attachment for the modern (per-request) HTTP
 * leg. Mirrors `createFilesystemResource.subscribe`'s attach sequence but never
 * throws: a bad or unreachable URI is skipped (returns `false`) rather than
 * rejected, since the trigger is a client's `subscriptions/listen` filter, not a
 * `resources/subscribe` call that owes the caller a precise error. Idempotent
 * per URI — a second call for an already-watched URI re-registers the notify
 * callback (one watcher per URI).
 *
 * ponytail: watchers persist for the server lifetime and are freed at shutdown
 * (the shared registry's `destroy()`), not removed when a listen stream closes.
 * Bounded by MAX_WATCHERS. Add per-stream refcounting only if distinct-URI churn
 * across clients exhausts the cap.
 */
export async function attachFileWatcherForUri(
  registry: WatcherRegistry,
  pathGuard: PathGuard,
  uri: string,
  notify: (uri: string) => void,
): Promise<boolean> {
  if (registry.hasWatcher(uri)) {
    registry.addCallback(uri, notify);
    return true;
  }
  if (registry.isAtCap()) {
    warnWatcherCap(uri);
    return false;
  }

  const filePath = extractPath(uri);
  if (filePath === undefined) return false;

  let resolved: string;
  try {
    resolved = await pathGuard.validateExistingPath(filePath);
  } catch {
    return false;
  }

  // Re-check what the await could have changed.
  if (registry.isStale(uri)) return false;
  if (registry.hasWatcher(uri)) {
    registry.addCallback(uri, notify);
    return true;
  }
  if (registry.isAtCap()) {
    warnWatcherCap(uri);
    return false;
  }

  registry.addCallback(uri, notify);
  if (!registry.attach(uri, resolved)) {
    // fs.watch threw (inotify exhaustion, or a race deleted the path): roll back
    // so no dangling callback is left believing a watcher exists.
    registry.remove(uri);
    return false;
  }
  return true;
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
          } catch (err) {
            // ENOENT: root vanished mid-list. Anything else (EACCES, EBUSY):
            // root exists but is unreadable. Either way omit lastModified and
            // keep the entry — list() must not throw for one bad root.
            const code = (err as NodeJS.ErrnoException | undefined)?.code;
            if (code && code !== 'ENOENT') {
              /* unreadable root: best-effort, no log channel in list() */
            }
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

      if (registry.hasWatcher(uri)) {
        // A watcher already tracks this uri; just (re)register the callback so
        // its change events reach the new subscriber. No validation or cap
        // work is needed for an already-live watcher.
        registry.addCallback(uri, notify);
        return;
      }
      // A cap hit before validation is reported to the caller as an outright
      // rejection. A cap hit found after the validation await is the same
      // condition, so it is also rejected — returning undefined here would let
      // the handler report success with no watcher attached.
      if (registry.isAtCap()) {
        warnWatcherCap(uri);
        return false;
      }

      registry.startSubscribe(uri);

      const filePath = extractPath(uri);
      if (!filePath) {
        throw new ResourceNotFoundError(uri, `Cannot subscribe: not a filesystem URI`);
      }

      let resolved: string;
      try {
        resolved = await options.pathGuard.validateExistingPath(filePath);
      } catch (err: unknown) {
        if (
          isFsError(err) &&
          (err.code === ErrorCode.NOT_FOUND || err.code === ErrorCode.ACCESS_DENIED)
        ) {
          throw new ResourceNotFoundError(uri, `Cannot subscribe to ${uri}: ${err.message}`);
        }
        Logger.warn(
          `Unexpected error validating path for watcher ${uri}: ${formatUnknownErrorMessage(err)}`,
        );
        throw err;
      }

      // Re-check what the await could have changed.
      if (registry.isStale(uri)) return;
      if (registry.hasWatcher(uri)) {
        registry.addCallback(uri, notify);
        return;
      }
      if (registry.isAtCap()) {
        warnWatcherCap(uri);
        return false;
      }

      registry.addCallback(uri, notify);
      if (!registry.attach(uri, resolved)) {
        // fs.watch threw synchronously (e.g. inotify exhaustion, or a race
        // deleted the path): roll back the callback we just registered and
        // reject, so the caller is not left believing it is subscribed while
        // no watcher exists.
        registry.remove(uri);
        return false;
      }
      return undefined;
    },

    unsubscribe(uri) {
      registry.remove(uri);
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
    mimeType: 'text/plain',
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
          'Cached result expired. Re-run the tool to regenerate.',
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
      if (entry.kind === 'text') {
        return {
          contents: [{ uri: entry.uri, mimeType: entry.mimeType, text: entry.text }],
        };
      }
      return {
        contents: [
          {
            uri: entry.uri,
            mimeType: entry.mimeType,
            blob: entry.data.toString('base64'),
          },
        ],
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
      throw new ProtocolError(ProtocolErrorCode.InvalidRequest, formatUnknownErrorMessage(error));
    }
  };
}

function registerResourceContracts(
  server: McpServer,
  options: ResourceRegistrationOptions,
): ResourceContract[] {
  const resourceContracts = getResourceContracts({ ...options, server });

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
              if (options.notifier) {
                options.notifier.resourceUpdated(updatedUri);
                return;
              }
              const updatePayload: ResourceUpdatedNotificationParams = { uri: updatedUri };
              void server.server.sendResourceUpdated(updatePayload).catch((err: unknown) => {
                const msg = formatUnknownErrorMessage(err);
                if (!msg.includes('closed') && !msg.includes('Transport')) {
                  Logger.warn(`Failed to send resource update for ${updatedUri}: ${msg}`);
                }
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

  return resourceContracts;
}

export function registerResources(deps: ServerDeps): { dispose(): void } {
  const contracts = registerResourceContracts(deps.server, {
    resourceStore: deps.resourceStore,
    pathGuard: deps.pathGuard,
    server: deps.server,
    ...(deps.watcherRegistry ? { watcherRegistry: deps.watcherRegistry } : {}),
    ...(deps.notifier ? { notifier: deps.notifier } : {}),
    readOnly: deps.readOnly ?? false,
  });

  return {
    dispose(): void {
      for (const contract of contracts) {
        if (contract.destroy) {
          contract.destroy();
        }
      }
    },
  };
}
