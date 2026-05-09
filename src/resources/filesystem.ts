import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { ServerContext } from '@modelcontextprotocol/server';

import { type FSWatcher, watch } from 'node:fs';

import { readFileWithStats } from '../core/fs.js';
import { completePathCached } from '../core/path.js';
import type { ResourceContract } from './contract.js';
import type { ResourceRegistrationOptions } from './shared.js';

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

export function createFilesystemResource(options: ResourceRegistrationOptions): ResourceContract {
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
      const rawPath = variables.path;
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
