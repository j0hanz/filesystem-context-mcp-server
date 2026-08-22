import type {
  McpServer,
  ReadResourceResult,
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

import type { FSWatcher } from 'node:fs';
import { watch } from 'node:fs';

import { ErrorCode, formatUnknownErrorMessage, hasErrorShape, isFsError } from './core/errors.js';
import { extractPath, FILESYSTEM_FILE_URI_TEMPLATE } from './core/file-uri.js';
import { GuardedFileSystem } from './core/fs.js';
import { Logger } from './core/observability.js';
import { PathCompleter } from './core/path-completer.js';
import type { PathGuard } from './core/path.js';
import type { IconInfo } from './core/primitives.js';
import { withDefaultIcons } from './core/primitives.js';
import type { Registrar, ServerDeps } from './core/registrar.js';
import type { ResourceStore } from './core/store.js';
import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  MAX_SEARCH_RESULTS,
  MAX_TEXT_FILE_SIZE,
  parseEnvInt,
} from './core/util.js';
import {
  CALCULATE_HASH,
  GET_FILE_INFO,
  LIST,
  LIST_ALLOWED_DIRECTORIES,
  MUTATING_TOOL_NAMES,
  READ_FILE,
  SEARCH_CONTENT,
  SEARCH_FILES,
} from './tools/index.js';

// ═══════════════════════════════════════════════════════════════
// shared
// ═══════════════════════════════════════════════════════════════

export interface ResourceRegistrationOptions {
  resourceStore: ResourceStore;
  iconInfo?: IconInfo;
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
  /**
   * Modern-leg notify sink: publishes a resource-updated event to the
   * ServerEventBus (broadcast to `subscriptions/listen` streams). When set, the
   * subscribe handler uses it instead of `sendResourceUpdated`.
   */
  notifyResourceUpdated?: (uri: string) => void;
}

// ═══════════════════════════════════════════════════════════════
// contract
// ═══════════════════════════════════════════════════════════════

interface BaseResourceContract {
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
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

function buildToolsOverview(readOnly: boolean): string {
  const rows: [string, string[]][] = [
    ['Navigate', [LIST_ALLOWED_DIRECTORIES.name, LIST.name, SEARCH_FILES.name]],
    ['Inspect', [GET_FILE_INFO.name, SEARCH_CONTENT.name, CALCULATE_HASH.name]],
    ['Read', [READ_FILE.name]],
  ];

  // Under --read-only the mutating tools are never registered, so advertising
  // them here would point the model at tools that are not there. Drop the row
  // rather than emit an empty one.
  if (!readOnly) {
    rows.push(['Write', [...MUTATING_TOOL_NAMES]]);
  }

  const rowLines = rows.map(([cat, names]) => `${cat}: ${names.join(', ')}`);
  return `\`\`\`\n${rowLines.join('\n')}\n\`\`\``;
}

export const INSTRUCTIONS_URI = 'internal://instructions';

export function buildSectionsRecord(readOnly: boolean): Record<string, string> {
  const maxFileMb = Math.floor(MAX_TEXT_FILE_SIZE / 1024 / 1024);
  return {
    guidelines: [
      'Guidelines:',
      '```',
      'root_access: When using filesystem tools, operate strictly within allowed roots.',
      'path_resolution: Always resolve paths before acting — never assume.',
      '```',
    ].join('\n'),
    tools_overview: [
      'Tools Overview:',
      buildToolsOverview(readOnly),
      '',
      'Full schemas, descriptions, and annotations are in `tools/list`.',
    ].join('\n'),
    constraints: [
      'Constraints:',
      '```',
      'allowed_roots: Operate within allowed roots only (negotiated at startup via CLI).',
      'sensitive_paths: Sensitive file paths (.env, *.pem, *id_rsa*) are denied by default.',
      `enforced_limits: max file size ${maxFileMb} MB, file search cap ${MAX_SEARCH_RESULTS} results, content search cap ${DEFAULT_SEARCH_CONTENT_RESULTS} matches.`,
      'ephemeral_results: When a tool returns resourceUri, call resources/read immediately — cached results are ephemeral and expire after ~60 seconds, eviction, or restart.',
      '```',
    ].join('\n'),
    error_recovery: [
      'Error Recovery:',
      '```',
      'ACCESS_DENIED: Run list_roots to list allowed directories, retry with a valid path.',
      'NOT_FOUND: Run list or find_files to verify the path.',
      'TOO_LARGE: Use read with head/tail or startLine/endLine, or split across several read calls.',
      'TIMEOUT: Reduce scope, depth, or maxResults.',
      'INVALID_INPUT: Re-read the tool schema in tools/list.',
      '```',
    ].join('\n'),
  };
}

export function renderSections(sections: Record<string, string>): string {
  return `\n${Object.values(sections).join('\n\n')}\n`;
}

function createInstructionsResource(options: ResourceRegistrationOptions): ResourceContract {
  const text = renderSections(buildSectionsRecord(options.readOnly));
  return {
    name: 'filesystem-mcp-instructions',
    title: 'Server Instructions',
    description: 'Navigation guide for filesystem-mcp tools and constraints.',
    mimeType: 'text/markdown',
    uri: INSTRUCTIONS_URI,
    annotations: { audience: ['assistant'], priority: 0.8 },
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

// Cap concurrent file watchers to avoid exhausting OS-level watch handles
// (e.g. Linux inotify, default ~8192/user). One subscription == one watcher.
const MAX_WATCHERS = parseEnvInt('FILESYSTEM_MCP_MAX_WATCHERS', 256, 1, 4096);

function warnWatcherCap(uri: string): void {
  Logger.warn(`Cannot subscribe to ${uri}: MAX_WATCHERS limit (${MAX_WATCHERS}) reached.`);
}

/**
 * Owns the uri → FSWatcher map and the subscription bookkeeping around it:
 * notify callbacks, desired subscribe/unsubscribe state, and the watcher cap.
 * `subscribe` awaits path validation midway, so callers re-check `isStale` and
 * `hasWatcher` after the await before attaching.
 */
export function createWatcherRegistry() {
  const watchers = new Map<string, FSWatcher>();
  const activeCallbacks = new Map<string, (uri: string) => void>();
  const desiredState = new Map<string, 'subscribed' | 'unsubscribed' | 'subscribing'>();
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  let destroyed = false;

  const dropWatcher = (uri: string, watcher: FSWatcher): void => {
    const current = watchers.get(uri);
    if (current !== watcher) return;
    const timer = debounceTimers.get(uri);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(uri);
    }
    watcher.close();
    watchers.delete(uri);
    activeCallbacks.delete(uri);
    desiredState.set(uri, 'unsubscribed');
  };

  const notifyAll = (uri: string): void => {
    if (!activeCallbacks.has(uri)) return;
    const existing = debounceTimers.get(uri);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      debounceTimers.delete(uri);
      const cb = activeCallbacks.get(uri);
      if (!cb) return;
      try {
        cb(uri);
      } catch (err) {
        Logger.warn(`Notify callback error for ${uri}: ${formatUnknownErrorMessage(err)}`);
      }
    }, 50);
    timer.unref();
    debounceTimers.set(uri, timer);
  };

  return {
    hasWatcher: (uri: string): boolean => watchers.has(uri),

    isAtCap: (): boolean => watchers.size >= MAX_WATCHERS,

    /** The registry was destroyed, or this uri was unsubscribed, mid-await. */
    isStale: (uri: string): boolean => destroyed || desiredState.get(uri) === 'unsubscribed',

    startSubscribe(uri: string): void {
      desiredState.set(uri, 'subscribing');
    },

    addCallback(uri: string, notify: (uri: string) => void): void {
      activeCallbacks.set(uri, notify);
      desiredState.set(uri, 'subscribed');
    },

    attach(uri: string, resolvedPath: string): boolean {
      try {
        const watcher = watch(resolvedPath, () => {
          notifyAll(uri);
        });
        watcher.on('error', (err: Error) => {
          Logger.warn(`Watcher error for ${uri}: ${err.message}`);
          dropWatcher(uri, watcher);
        });
        watchers.set(uri, watcher);
        return true;
      } catch (err) {
        Logger.error(`Failed to create watcher for ${uri}: ${formatUnknownErrorMessage(err)}`);
        return false;
      }
    },

    remove(uri: string): void {
      desiredState.set(uri, 'unsubscribed');
      activeCallbacks.delete(uri);
      const timer = debounceTimers.get(uri);
      if (timer) {
        clearTimeout(timer);
        debounceTimers.delete(uri);
      }
      const watcher = watchers.get(uri);
      if (watcher) {
        dropWatcher(uri, watcher);
      }
    },

    destroy(): void {
      destroyed = true;
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
      for (const watcher of watchers.values()) {
        try {
          watcher.close();
        } catch {
          /* ignore close errors so all watchers are attempted */
        }
      }
      watchers.clear();
      activeCallbacks.clear();
      desiredState.clear();
    },
  };
}

export type WatcherRegistry = ReturnType<typeof createWatcherRegistry>;

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
    description: 'Ephemeral cached tool output. Not listed via resources/list.',
    mimeType: 'text/plain',
    uriTemplate: 'filesystem-mcp://result/{id}',
    annotations: { audience: ['assistant'], priority: 0.3 },
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

function registerResources(
  server: McpServer,
  options: ResourceRegistrationOptions,
): ResourceContract[] {
  const resourceContracts = getResourceContracts({ ...options, server });

  for (const contract of resourceContracts) {
    const config = withDefaultIcons(
      {
        title: contract.title,
        description: contract.description,
        mimeType: contract.mimeType,
        annotations: contract.annotations,
      },
      options.iconInfo,
    );

    if (contract.uriTemplate) {
      const template = new ResourceTemplate(contract.uriTemplate, {
        list: undefined,
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
      server.registerResource(contract.name, contract.uri, config, (uri, ctx) =>
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
              if (options.notifyResourceUpdated) {
                options.notifyResourceUpdated(updatedUri);
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

export const resourcesRegistrar: Registrar = (() => {
  const serverContracts = new Map<McpServer, ResourceContract[]>();

  return {
    register(deps: ServerDeps): void {
      const contracts = registerResources(deps.server, {
        resourceStore: deps.resourceStore,
        pathGuard: deps.pathGuard,
        server: deps.server,
        ...(deps.iconInfo ? { iconInfo: deps.iconInfo } : {}),
        ...(deps.watcherRegistry ? { watcherRegistry: deps.watcherRegistry } : {}),
        ...(deps.notifyResourceUpdated
          ? { notifyResourceUpdated: deps.notifyResourceUpdated }
          : {}),
        readOnly: deps.readOnly ?? false,
      });
      serverContracts.set(deps.server, contracts);
    },

    dispose(server?: McpServer): void {
      if (server) {
        const contracts = serverContracts.get(server);
        if (contracts) {
          for (const contract of contracts) {
            if (contract.destroy) {
              contract.destroy();
            }
          }
          serverContracts.delete(server);
        }
      } else {
        for (const contracts of serverContracts.values()) {
          for (const contract of contracts) {
            if (contract.destroy) {
              contract.destroy();
            }
          }
        }
        serverContracts.clear();
      }
    },
  };
})();
