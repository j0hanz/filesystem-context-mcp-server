import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { ServerContext } from '@modelcontextprotocol/server';

import { type FSWatcher, watch } from 'node:fs';
import { readFile as readFilePromises } from 'node:fs/promises';

import { completePathCached } from '../lib/path-completer.js';
import { detectMimeType } from '../lib/mime.js';

import type { ResourceContract } from './contract.js';
import type { ResourceRegistrationOptions } from './shared.js';

export const FILESYSTEM_FILE_URI_TEMPLATE = 'filesystem-mcp://file/{+path}';
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

export function createFilesystemResource(
  options: ResourceRegistrationOptions
): ResourceContract {
  const watchers = new Map<string, FSWatcher>();

  return {
    name: 'filesystem-mcp-file',
    title: 'Workspace File',
    description:
      'Read a file from the workspace. Subscribe to get updates when the file changes.',
    uriTemplate: FILESYSTEM_FILE_URI_TEMPLATE,
    annotations: { audience: ['assistant'], priority: 0.8 },

    async read(uri, variables, _ctx: ServerContext) {
      if (!options.pathGuard) {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          'PathGuard not configured'
        );
      }
      const rawPath = variables.path;
      if (!rawPath) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          'Path variable is required'
        );
      }
      const targetPath = '/' + rawPath;
      const resolved = await options.pathGuard.validateExistingPath(targetPath);

      const content = await readFilePromises(resolved);
      const mimeInfo = detectMimeType(resolved, content.subarray(0, 512));
      const isBinary = mimeInfo.kind !== 'text';

      return {
        contents: [
          isBinary
            ? {
                uri: uri.href,
                mimeType: mimeInfo.mimeType,
                blob: content.toString('base64'),
              }
            : {
                uri: uri.href,
                mimeType: mimeInfo.mimeType,
                text: content.toString('utf-8'),
              },
        ],
      };
    },

    async complete(variable, value) {
      if (variable === 'path' && options.pathGuard) {
        // value doesn't have the leading '/' because the template expands as {+path} (without root slash if typed as relative)
        // path-completer expects absolute paths starting with /, but we must handle relative typing
        return completePathCached('/' + value, { pathGuard: options.pathGuard });
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
