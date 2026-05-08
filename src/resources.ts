import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type ReadResourceResult,
  ResourceTemplate,
} from '@modelcontextprotocol/server';

import { type FSWatcher, watch } from 'node:fs';

import type { PathGuard } from './lib/path-guard.js';
import type { ResourceStore } from './lib/resource-store.js';

import { SLIM_INSTRUCTIONS_CONTENT } from './resources/instructions-content.js';
import { type IconInfo, withDefaultIcons } from './tools/shared.js';

export interface ResourceRegistrationOptions {
  resourceStore: ResourceStore;
  iconInfo?: IconInfo;
  pathGuard?: PathGuard;
}

export interface ResourcesHandle {
  destroy(): void;
}

export { SLIM_INSTRUCTIONS_CONTENT as serverInstructionsContent };

const INSTRUCTIONS_URI = 'internal://instructions';
const RESULT_TEMPLATE = new ResourceTemplate('filesystem-mcp://result/{id}', {
  list: undefined,
});

// ─── File-watch subscription helpers ─────────────────────────────────────────

const FILE_URI_PREFIX = 'filesystem-mcp://file';

function uriToAbsoluteFilePath(uri: string): string | undefined {
  if (!uri.startsWith(FILE_URI_PREFIX)) return undefined;
  const rawPath = uri.slice(FILE_URI_PREFIX.length);
  if (!rawPath.startsWith('/')) return undefined;
  try {
    return decodeURIComponent(rawPath.slice(1));
  } catch {
    return undefined;
  }
}

export function registerAllResources(
  server: McpServer,
  options: ResourceRegistrationOptions
): ResourcesHandle {
  server.registerResource(
    'filesystem-mcp-instructions',
    INSTRUCTIONS_URI,
    withDefaultIcons(
      {
        title: 'Server Instructions',
        description:
          'Navigation guide for filesystem-mcp tools and constraints.',
        mimeType: 'text/markdown',
        annotations: { audience: ['assistant'], priority: 0.8 },
      },
      options.iconInfo
    ),
    (uri): ReadResourceResult => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: SLIM_INSTRUCTIONS_CONTENT,
        },
      ],
    })
  );

  server.registerResource(
    'filesystem-mcp-result',
    RESULT_TEMPLATE,
    withDefaultIcons(
      {
        title: 'Cached Tool Result',
        description:
          'Ephemeral cached tool output. Not listed via resources/list.',
        mimeType: 'text/plain',
        annotations: { audience: ['assistant'], priority: 0.3 },
      },
      options.iconInfo
    ),
    (uri, variables): ReadResourceResult => {
      const { id } = variables;
      if (typeof id !== 'string' || id.length === 0) {
        throw new ProtocolError(
          ProtocolErrorCode.ResourceNotFound,
          'Cached result expired. Re-run the tool to regenerate.'
        );
      }
      const entry = options.resourceStore.getEntry(uri.toString());
      if (entry.kind === 'text') {
        return {
          contents: [
            { uri: entry.uri, mimeType: entry.mimeType, text: entry.text },
          ],
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
    }
  );

  // ─── File-watch subscriptions ─────────────────────────────────────────────

  const watchers = new Map<string, FSWatcher>();

  server.server.setRequestHandler(
    'resources/subscribe',
    async (req: { params: { uri: string } }) => {
      const { uri } = req.params;
      if (options.pathGuard && !watchers.has(uri)) {
        const filePath = uriToAbsoluteFilePath(uri);
        if (filePath) {
          try {
            const resolved =
              await options.pathGuard.validateExistingPath(filePath);
            const watcher = watch(resolved, () => {
              void server.server.sendResourceUpdated({ uri }).catch(() => {
                // Transport may already be closed — best effort.
              });
            });
            watchers.set(uri, watcher);
          } catch {
            // Path not allowed or does not exist — silently ignore.
          }
        }
      }
      return {};
    }
  );

  server.server.setRequestHandler(
    'resources/unsubscribe',
    (req: { params: { uri: string } }) => {
      const watcher = watchers.get(req.params.uri);
      if (watcher) {
        watcher.close();
        watchers.delete(req.params.uri);
      }
      return {};
    }
  );

  return {
    destroy(): void {
      for (const watcher of watchers.values()) {
        watcher.close();
      }
      watchers.clear();
    },
  };
}
