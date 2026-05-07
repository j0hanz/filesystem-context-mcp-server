import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type ReadResourceResult,
  ResourceTemplate,
} from '@modelcontextprotocol/server';

import { type FSWatcher, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { withDefaultIcons } from '../tools/shared.js';
import type {
  ResourceContract,
  ResourceSubscriptionLifecycle,
} from './contract.js';
import {
  resourceMetadata,
  type ResourceRegistrationOptions,
} from './shared.js';

const FILESYSTEM_FILE_URI_TEMPLATE = 'filesystem-mcp://file/{+path}';
const FILE_URI_PREFIX = 'filesystem-mcp://file/';

const FILE_TEMPLATE = new ResourceTemplate(FILESYSTEM_FILE_URI_TEMPLATE, {
  list: undefined,
});

function guessMimeType(filePath: string): string {
  if (filePath.endsWith('.json')) return 'application/json';
  if (filePath.endsWith('.md')) return 'text/markdown';
  if (filePath.endsWith('.html') || filePath.endsWith('.htm'))
    return 'text/html';
  if (filePath.endsWith('.ts') || filePath.endsWith('.js'))
    return 'text/javascript';
  return 'text/plain';
}

function createFileSubscription(
  notify: (uri: string) => void
): ResourceSubscriptionLifecycle {
  const watchers = new Map<string, FSWatcher>();

  function onSubscribe(uri: string): void {
    if (watchers.has(uri) || !uri.startsWith(FILE_URI_PREFIX)) return;
    const decoded = decodeURIComponent(uri.slice(FILE_URI_PREFIX.length));
    try {
      const watcher = watch(decoded, { persistent: false }, () => {
        notify(uri);
      });
      watcher.once('error', () => {
        watcher.close();
        watchers.delete(uri);
      });
      watchers.set(uri, watcher);
    } catch {
      // Path not watchable — silent. Client gets ResourceNotFound on next read.
    }
  }

  function onUnsubscribe(uri: string): void {
    watchers.get(uri)?.close();
    watchers.delete(uri);
  }

  function destroy(): void {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  }

  return { onSubscribe, onUnsubscribe, destroy };
}

export const FILESYSTEM_FILE_RESOURCE: ResourceContract = {
  name: 'filesystem-mcp-file',
  uriTemplate: FILESYSTEM_FILE_URI_TEMPLATE,
  title: 'File',
  description:
    'Read any file within allowed roots as a resource. ' +
    'Subscribe to receive notifications/resources/updated when the file changes on disk.',
  mimeType: 'text/plain',
  annotations: { audience: ['assistant'], priority: 0.4 },
  createSubscription: (notify) => createFileSubscription(notify),
};

export function registerFilesystemFileResource(
  server: McpServer,
  options: ResourceRegistrationOptions
): void {
  server.registerResource(
    FILESYSTEM_FILE_RESOURCE.name,
    FILE_TEMPLATE,
    withDefaultIcons(
      { ...resourceMetadata(FILESYSTEM_FILE_RESOURCE) },
      options.iconInfo
    ),
    async (uri, variables): Promise<ReadResourceResult> => {
      const rawPath = variables.path;
      if (typeof rawPath !== 'string' || rawPath.length === 0) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          'path is required'
        );
      }
      const safePath = await options.pathGuard.validateExistingPath(
        decodeURIComponent(rawPath)
      );
      const content = await readFile(safePath, 'utf-8');
      return {
        contents: [
          { uri: uri.href, mimeType: guessMimeType(safePath), text: content },
        ],
      };
    }
  );
}
