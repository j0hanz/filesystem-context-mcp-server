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
  ResourceTemplate,
  resourceUrlFromServerUrl,
  UriTemplate,
} from '@modelcontextprotocol/server';

import type { FSWatcher } from 'node:fs';
import { watch } from 'node:fs';

import { ErrorCode, FsError } from './core/errors.js';
import { readFileRaw } from './core/fs.js';
import { withTelemetry } from './core/observability.js';
import type { PathGuard } from './core/path.js';
import { PathCompleter } from './core/path.js';
import type { Registrar, ServerDeps } from './core/registrar.js';
import type { ResourceStore } from './core/store.js';
import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  MAX_SEARCH_RESULTS,
  MAX_TEXT_FILE_SIZE,
  parseEnvInt,
} from './core/util.js';
import type { IconInfo } from './tools/define.js';
import { withDefaultIcons } from './tools/define.js';

// ═══════════════════════════════════════════════════════════════
// shared
// ═══════════════════════════════════════════════════════════════

export interface ResourceRegistrationOptions {
  resourceStore: ResourceStore;
  iconInfo?: IconInfo;
  pathGuard?: PathGuard;
  server?: McpServer;
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
  read(
    uri: URL,
    variables: Record<string, string | string[]>,
    ctx: ServerContext,
  ): Promise<ReadResourceResult> | ReadResourceResult;
  subscribe?: (uri: string, notify: (uri: string) => void) => boolean | undefined;
  unsubscribe?: (uri: string) => void;
  destroy?: () => void;
}

/** A resource with a fixed, enumerable URI (e.g. internal://instructions). */
interface StaticResourceContract extends BaseResourceContract {
  uri: string;
  uriTemplate?: never;
  complete?: never;
}

/** A resource identified by a URI template (e.g. filesystem-mcp://file/{+path}). */
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

function pickAvailableToolNames(names: readonly string[]): string[] {
  return [...names];
}

function buildToolsOverview(): string {
  const rows: [string, string[]][] = [
    ['Navigate', pickAvailableToolNames(['list_roots', 'list', 'find_files'])],
    ['Inspect', pickAvailableToolNames(['stat', 'search_text', 'hash_file'])],
    ['Read', pickAvailableToolNames(['read'])],
    ['Write', pickAvailableToolNames(['create', 'edit', 'move', 'delete', 'replace_text'])],
  ];

  const rowLines = rows
    .filter(([, names]) => names.length > 0)
    .map(([cat, names]) => `${cat}: ${names.join(', ')}`);
  return `\`\`\`\n${rowLines.join('\n')}\n\`\`\``;
}

function buildSectionsRecord(): Record<string, string> {
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
      buildToolsOverview(),
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
      'NOT_FOUND: Run ls or find to verify the path.',
      'TOO_LARGE: Use head/tail, line ranges, or split across read_many.',
      'TIMEOUT: Reduce scope, depth, or maxResults.',
      'INVALID_INPUT: Re-read the tool schema in tools/list.',
      '```',
    ].join('\n'),
  };
}

export const INSTRUCTION_SECTIONS: Record<string, string> = buildSectionsRecord();

export const SERVER_INSTRUCTIONS_CONTENT = `\n${Object.values(INSTRUCTION_SECTIONS).join('\n\n')}\n`;

export { SERVER_INSTRUCTIONS_CONTENT as serverInstructionsContent };

function createInstructionsResource(): ResourceContract {
  return {
    name: 'filesystem-mcp-instructions',
    title: 'Server Instructions',
    description: 'Navigation guide for filesystem-mcp tools and constraints.',
    mimeType: 'text/markdown',
    uri: 'internal://instructions',
    annotations: { audience: ['assistant'], priority: 0.8 },
    read(uri) {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: SERVER_INSTRUCTIONS_CONTENT,
          },
        ],
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// filesystem
// ═══════════════════════════════════════════════════════════════

const FILESYSTEM_FILE_URI_TEMPLATE = 'filesystem-mcp://file/{+path}';

// Cap concurrent file watchers to avoid exhausting OS-level watch handles
// (e.g. Linux inotify, default ~8192/user). One subscription == one watcher.
const MAX_WATCHERS = parseEnvInt('FILESYSTEM_MCP_MAX_WATCHERS', 256, 1, 4096);

let watchFactory: (path: string, listener: () => void) => FSWatcher = (path, listener) =>
  watch(path, listener);

export function setWatchFactoryForTests(
  factory?: (path: string, listener: () => void) => FSWatcher,
): void {
  watchFactory = factory ?? ((path, listener) => watch(path, listener));
}

function extractPath(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'filesystem-mcp:' || url.host !== 'file') return undefined;
    return decodeURIComponent(url.pathname.slice(1));
  } catch {
    return undefined;
  }
}

function createFilesystemResource(options: ResourceRegistrationOptions): ResourceContract {
  const completer = options.pathGuard ? new PathCompleter(options.pathGuard) : undefined;
  const watchers = new Map<string, FSWatcher>();
  const activeCallbacks = new Map<string, Set<(uri: string) => void>>();
  const desiredState = new Map<string, 'subscribed' | 'unsubscribed'>();
  // Tracks URIs whose watcher is being created (validateExistingPath is async).
  const pending = new Set<string>();
  let destroyed = false;

  const dropWatcher = (uri: string, watcher: FSWatcher): void => {
    const current = watchers.get(uri);
    if (current !== watcher) return;
    watcher.close();
    watchers.delete(uri);
    activeCallbacks.delete(uri);
    desiredState.set(uri, 'unsubscribed');
  };

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
      const rawPath = variables['path'];
      if (typeof rawPath !== 'string') {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          'Path variable is required and must be a string',
        );
      }
      await options.pathGuard.validateExistingPath(rawPath);
      const readResult = await readFileRaw(rawPath, options.pathGuard);

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

    subscribe(uri, notify) {
      if (!options.pathGuard) return;

      let callbacks = activeCallbacks.get(uri);
      if (!callbacks) {
        callbacks = new Set();
        activeCallbacks.set(uri, callbacks);
      }
      callbacks.add(notify);

      desiredState.set(uri, 'subscribed');

      if (watchers.has(uri)) return;

      if (watchers.size >= MAX_WATCHERS) {
        options.server
          ?.sendLoggingMessage({
            level: 'warning',
            logger: 'filesystem-mcp',
            data: `Cannot subscribe to ${uri}: MAX_WATCHERS limit (${MAX_WATCHERS}) reached.`,
          })
          .catch(() => {
            /* ignore */
          });
        return false;
      }

      if (pending.has(uri)) return true;

      const filePath = extractPath(uri);
      if (!filePath) {
        options.server
          ?.sendLoggingMessage({
            level: 'warning',
            logger: 'filesystem-mcp',
            data: `Cannot subscribe to malformed or non-filesystem URI: ${uri}`,
          })
          .catch(() => {
            /* ignore */
          });
        return;
      }

      pending.add(uri);
      options.pathGuard
        .validateExistingPath(filePath)
        .then((resolved) => {
          if (destroyed) return;
          if (desiredState.get(uri) === 'unsubscribed') {
            return;
          }
          if (watchers.has(uri)) return;
          if (watchers.size >= MAX_WATCHERS) {
            options.server
              ?.sendLoggingMessage({
                level: 'warning',
                logger: 'filesystem-mcp',
                data: `Cannot subscribe to ${uri}: MAX_WATCHERS limit (${MAX_WATCHERS}) reached.`,
              })
              .catch(() => {
                /* ignore */
              });
            return;
          }

          try {
            const watcher = watchFactory(resolved, () => {
              const currentCallbacks = activeCallbacks.get(uri);
              if (currentCallbacks) {
                for (const cb of currentCallbacks) {
                  try {
                    cb(uri);
                  } catch (err) {
                    options.server
                      ?.sendLoggingMessage({
                        level: 'warning',
                        logger: 'filesystem-mcp',
                        data: `Notify callback error for ${uri}: ${err instanceof Error ? err.message : String(err)}`,
                      })
                      .catch(() => {
                        /* ignore */
                      });
                  }
                }
              }
            });
            watcher.on('error', (err: Error) => {
              options.server
                ?.sendLoggingMessage({
                  level: 'warning',
                  logger: 'filesystem-mcp',
                  data: `Watcher error for ${uri}: ${err.message}`,
                })
                .catch(() => {
                  /* ignore */
                });
              dropWatcher(uri, watcher);
            });
            watchers.set(uri, watcher);
          } catch (err) {
            options.server
              ?.sendLoggingMessage({
                level: 'error',
                logger: 'filesystem-mcp',
                data: `Failed to create watcher for ${uri}: ${err instanceof Error ? err.message : String(err)}`,
              })
              .catch(() => {
                /* ignore */
              });
          }
        })
        .catch((err: unknown) => {
          const isExpected =
            err instanceof FsError &&
            (err.code === ErrorCode.NOT_FOUND || err.code === ErrorCode.ACCESS_DENIED);
          if (!isExpected) {
            options.server
              ?.sendLoggingMessage({
                level: 'warning',
                logger: 'filesystem-mcp',
                data: `Unexpected error validating path for watcher ${uri}: ${err instanceof Error ? err.message : String(err)}`,
              })
              .catch(() => {
                /* ignore */
              });
          }
        })
        .finally(() => {
          pending.delete(uri);
        });
      return undefined;
    },

    unsubscribe(uri) {
      desiredState.set(uri, 'unsubscribed');
      activeCallbacks.delete(uri);
      const watcher = watchers.get(uri);
      if (watcher) {
        dropWatcher(uri, watcher);
      }
    },

    destroy() {
      destroyed = true;
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
        if (err instanceof FsError && err.code === ErrorCode.NOT_FOUND) {
          throw new ProtocolError(
            ProtocolErrorCode.ResourceNotFound,
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
    createInstructionsResource(),
    createResultResource(options),
    createFilesystemResource(options),
  ];
}

// ═══════════════════════════════════════════════════════════════
// registrar
// ═══════════════════════════════════════════════════════════════

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

      server.registerResource(contract.name, template, config, async (uri, variables, ctx) => {
        try {
          return await contract.read(uri, variables, ctx);
        } catch (error) {
          if (error instanceof ProtocolError) {
            throw error;
          }
          throw new ProtocolError(
            ProtocolErrorCode.InvalidRequest,
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    } else if (contract.uri) {
      server.registerResource(contract.name, contract.uri, config, async (uri, ctx) => {
        try {
          return await contract.read(uri, {}, ctx);
        } catch (error) {
          if (error instanceof ProtocolError) {
            throw error;
          }
          throw new ProtocolError(
            ProtocolErrorCode.InvalidRequest,
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    }
  }

  server.server.setRequestHandler(
    'resources/subscribe',
    (req: { params: SubscribeRequestParams }, ctx) => {
      const requestedResource = resourceUrlFromServerUrl(req.params.uri);
      return withTelemetry(
        {
          event: 'resource_subscription',
          action: 'subscribe',
          uri: requestedResource.toString(),
          session_id: ctx.sessionId ?? null,
        },
        () => {
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
              const subscribeResult = contract.subscribe(
                requestedResource.toString(),
                (updatedUri) => {
                  const updatePayload: ResourceUpdatedNotificationParams = { uri: updatedUri };
                  void server.server.sendResourceUpdated(updatePayload).catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (!msg.includes('closed') && !msg.includes('Transport')) {
                      void options.server
                        ?.sendLoggingMessage({
                          level: 'warning',
                          logger: 'filesystem-mcp',
                          data: `Failed to send resource update for ${updatedUri}: ${msg}`,
                        })
                        .catch(() => {
                          /* ignore */
                        });
                    }
                  });
                },
              );
              if (subscribeResult === false) {
                throw new ProtocolError(
                  ProtocolErrorCode.InternalError,
                  `Subscription rejected: watcher limit (${MAX_WATCHERS}) reached.`,
                );
              }
              break;
            }
          }
          if (!foundMatch) {
            throw new ProtocolError(
              ProtocolErrorCode.ResourceNotFound,
              `Resource not found: ${requestedResource.toString()}`,
            );
          }
          return {};
        },
      );
    },
  );

  server.server.setRequestHandler(
    'resources/unsubscribe',
    (req: { params: UnsubscribeRequestParams }, ctx) => {
      const canonical = resourceUrlFromServerUrl(req.params.uri).toString();
      return withTelemetry(
        {
          event: 'resource_subscription',
          action: 'unsubscribe',
          uri: canonical,
          session_id: ctx.sessionId ?? null,
        },
        () => {
          for (const contract of resourceContracts) {
            if (contract.unsubscribe) {
              contract.unsubscribe(canonical);
            }
          }
          return {};
        },
      );
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
