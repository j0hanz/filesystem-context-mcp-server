import {
  checkResourceAllowed,
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type ReadResourceResult,
  ResourceTemplate,
  type ResourceUpdatedNotificationParams,
  resourceUrlFromServerUrl,
  type Role,
  type ServerContext,
  type SubscribeRequestParams,
  type UnsubscribeRequestParams,
  UriTemplate,
} from '@modelcontextprotocol/server';

import { type FSWatcher, watch } from 'node:fs';

import { readFileRaw } from './core/fs.js';
import { withTelemetry } from './core/observability.js';
import { PathCompleter, type PathGuard } from './core/path.js';
import type { Registrar, ServerDeps } from './core/registrar.js';
import type { ResourceStore } from './core/store.js';
import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  MAX_SEARCH_RESULTS,
  MAX_TEXT_FILE_SIZE,
  parseEnvInt,
} from './core/util.js';
import { type IconInfo, withDefaultIcons } from './tools/define.js';

// ═══════════════════════════════════════════════════════════════
// shared
// ═══════════════════════════════════════════════════════════════

export interface ResourceRegistrationOptions {
  resourceStore: ResourceStore;
  iconInfo?: IconInfo;
  pathGuard?: PathGuard;
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
  subscribe?: (uri: string, notify: (uri: string) => void) => void;
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
const FILE_URI_PREFIX = 'filesystem-mcp://file';

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
  if (!uri.startsWith(FILE_URI_PREFIX)) return undefined;
  const rawPath = uri.slice(FILE_URI_PREFIX.length);
  if (!rawPath.startsWith('/')) return undefined;
  try {
    return decodeURIComponent(rawPath.slice(1));
  } catch {
    return undefined;
  }
}

function createFilesystemResource(options: ResourceRegistrationOptions): ResourceContract {
  const completer = options.pathGuard ? new PathCompleter(options.pathGuard) : undefined;
  const watchers = new Map<string, FSWatcher>();
  // Tracks URIs whose watcher is being created (validateExistingPath is async).
  // Without it, two concurrent subscribe() calls for the same URI both pass the
  // `watchers.has(uri)` check and the second watcher leaks (overwrites the first).
  const pending = new Set<string>();
  const cancelledSubscriptions = new Set<string>();
  const dropWatcher = (uri: string, watcher: FSWatcher): void => {
    const current = watchers.get(uri);
    if (current !== watcher) return;
    watcher.close();
    watchers.delete(uri);
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
      if (!options.pathGuard || watchers.has(uri) || pending.has(uri)) return;
      if (watchers.size >= MAX_WATCHERS) return;
      const filePath = extractPath(uri);
      if (!filePath) return;

      cancelledSubscriptions.delete(uri);
      pending.add(uri);
      options.pathGuard
        .validateExistingPath(filePath)
        .then((resolved) => {
          if (cancelledSubscriptions.has(uri)) {
            cancelledSubscriptions.delete(uri);
            return;
          }
          // Re-check after the async gap: the URI may have been subscribed or
          // the cap reached while validation was in flight.
          if (watchers.has(uri) || watchers.size >= MAX_WATCHERS) return;
          const watcher = watchFactory(resolved, () => {
            notify(uri);
          });
          watcher.on('error', () => {
            // Remove broken watchers so future subscribe calls can recover.
            dropWatcher(uri, watcher);
          });
          watchers.set(uri, watcher);
        })
        .catch(() => {
          /* silent ignore for unallowed/missing files */
        })
        .finally(() => {
          pending.delete(uri);
          cancelledSubscriptions.delete(uri);
        });
    },

    unsubscribe(uri) {
      const watcher = watchers.get(uri);
      if (watcher) {
        dropWatcher(uri, watcher);
      } else if (pending.has(uri)) {
        cancelledSubscriptions.add(uri);
      }
    },

    destroy() {
      for (const watcher of watchers.values()) {
        watcher.close();
      }
      watchers.clear();
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

      const entry = options.resourceStore.getEntry(uri.toString());
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
  const resourceContracts = getResourceContracts(options);

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
              contract.subscribe(requestedResource.toString(), (updatedUri) => {
                const updatePayload: ResourceUpdatedNotificationParams = { uri: updatedUri };
                void server.server.sendResourceUpdated(updatePayload).catch(() => {
                  /* Transport may be closed */
                });
              });
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
  let contracts: ResourceContract[] = [];

  return {
    register(deps: ServerDeps): void {
      contracts = registerResources(deps.server, {
        resourceStore: deps.resourceStore,
        pathGuard: deps.pathGuard,
        ...(deps.iconInfo ? { iconInfo: deps.iconInfo } : {}),
      });
    },

    dispose(): void {
      for (const contract of contracts) {
        if (contract.destroy) {
          contract.destroy();
        }
      }
      contracts = [];
    },
  };
})();
