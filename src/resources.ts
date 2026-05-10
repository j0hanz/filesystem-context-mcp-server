// src/resources.ts — inlined from src/resources/{shared,contract,instructions,filesystem,result}.ts
import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type ReadResourceResult,
  ResourceTemplate,
  type Role,
  type ServerContext,
} from '@modelcontextprotocol/server';

import { type FSWatcher, watch } from 'node:fs';

import uriTemplate from 'uri-templates';

import { readFileWithStats } from './core/fs.js';
import { completePathCached, type PathGuard } from './core/path.js';
import type { ResourceStore } from './core/store.js';
import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  MAX_SEARCH_RESULTS,
  MAX_TEXT_FILE_SIZE,
} from './core/util.js';
import { ALL_TOOLS } from './tools.js';
import { type IconInfo, withDefaultIcons } from './tools/_helpers.js';

// ═══════════════════════════════════════════════════════════════
// shared
// ═══════════════════════════════════════════════════════════════

export interface ResourceRegistrationOptions {
  resourceStore: ResourceStore;
  iconInfo?: IconInfo;
  pathGuard?: PathGuard;
}

export interface ResourcesHandle {
  destroy(): void;
}

// ═══════════════════════════════════════════════════════════════
// contract
// ═══════════════════════════════════════════════════════════════

interface ResourceContract {
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;

  uri?: string;
  uriTemplate?: string;

  annotations?: {
    audience?: Role[];
    priority?: number;
  };

  read: (
    uri: URL,
    variables: Record<string, string | string[]>,
    ctx: ServerContext,
  ) => Promise<ReadResourceResult> | ReadResourceResult;
  complete?: (
    variable: string,
    value: string,
    ctx?: { arguments?: Record<string, string> },
  ) => Promise<string[]> | string[];

  subscribe?: (uri: string, notify: (uri: string) => void) => void;
  unsubscribe?: (uri: string) => void;
  /** Global teardown hook to clean up watchers/timers */
  destroy?: () => void;
}

// ═══════════════════════════════════════════════════════════════
// instructions
// ═══════════════════════════════════════════════════════════════

function pickAvailableToolNames(names: readonly string[]): string[] {
  const nameSet = new Set(ALL_TOOLS.map((c) => c.name));
  return names.filter((name) => nameSet.has(name));
}

function buildToolsOverview(): string {
  const rows: [string, string[]][] = [
    ['Navigate', pickAvailableToolNames(['list_roots', 'ls', 'tree', 'find_files'])],
    ['Inspect', pickAvailableToolNames(['stat', 'search_text', 'hash_file'])],
    ['Read', pickAvailableToolNames(['read', 'diff_files'])],
    [
      'Write',
      pickAvailableToolNames([
        'make_dir',
        'write',
        'edit',
        'move',
        'delete',
        'apply_patch',
        'replace_text',
      ]),
    ],
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
      'ephemeral_results: When a tool returns resourceUri, call resources/read immediately — cached results are ephemeral and expire after 30 min, eviction, or restart.',
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
  const watchers = new Map<string, FSWatcher>();

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
      const readResult = await readFileWithStats(rawPath, options.pathGuard);

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
        return completePathCached(value, { pathGuard: options.pathGuard });
      }
      return [];
    },

    subscribe(uri, notify) {
      if (!options.pathGuard || watchers.has(uri)) return;
      const filePath = extractPath(uri);
      if (!filePath) return;

      options.pathGuard
        .validateExistingPath(filePath)
        .then((resolved) => {
          const watcher = watch(resolved, () => {
            notify(uri);
          });
          watcher.on('error', () => {
            /* ignore */
          });
          watchers.set(uri, watcher);
        })
        .catch(() => {
          /* silent ignore for unallowed/missing files */
        });
    },

    unsubscribe(uri) {
      const watcher = watchers.get(uri);
      if (watcher) {
        watcher.close();
        watchers.delete(uri);
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
          ProtocolErrorCode.ResourceNotFound,
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
// registerAllResources
// ═══════════════════════════════════════════════════════════════

export function registerAllResources(
  server: McpServer,
  options: ResourceRegistrationOptions,
): ResourcesHandle {
  const ALL_RESOURCES: ResourceContract[] = [
    createInstructionsResource(),
    createResultResource(options),
    createFilesystemResource(options),
  ];

  for (const contract of ALL_RESOURCES) {
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
                uriTemplate(contract.uriTemplate).varNames.map((varName) => [
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

      server.registerResource(
        contract.name,
        template,
        config,
        (uri: URL, variables: Record<string, string | string[]>, ctx: ServerContext) =>
          contract.read(uri, variables, ctx),
      );
    } else if (contract.uri) {
      server.registerResource(contract.name, contract.uri, config, (uri, ctx) =>
        contract.read(uri, {}, ctx),
      );
    }
  }

  // Hook into subscriptions routing
  server.server.setRequestHandler('resources/subscribe', (req: { params: { uri: string } }) => {
    const { uri } = req.params;
    for (const contract of ALL_RESOURCES) {
      if (contract.subscribe) {
        // Simplistic routing - normally we'd check if URI matches template or exact URI
        let matches = false;
        if (contract.uri && uri === contract.uri) matches = true;
        if (contract.uriTemplate) {
          // Check if URI matches the template prefix (e.g. filesystem-mcp://file/)
          const prefix = contract.uriTemplate.split('{')[0];
          if (prefix && uri.startsWith(prefix)) matches = true;
        }

        if (matches) {
          contract.subscribe(uri, (updatedUri) => {
            void server.server.sendResourceUpdated({ uri: updatedUri }).catch(() => {
              /* Transport may be closed */
            });
          });
          break;
        }
      }
    }
    return {};
  });

  server.server.setRequestHandler('resources/unsubscribe', (req: { params: { uri: string } }) => {
    const { uri } = req.params;
    for (const contract of ALL_RESOURCES) {
      if (contract.unsubscribe) {
        contract.unsubscribe(uri);
      }
    }
    return {};
  });

  return {
    destroy(): void {
      for (const contract of ALL_RESOURCES) {
        if (contract.destroy) {
          contract.destroy();
        }
      }
    },
  };
}
