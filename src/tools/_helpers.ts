import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import { buildFileResourceUri } from '../core/file-uri.js';
import type { FileInfo } from '../core/fs.js';
import type { ResourceStore } from '../core/store.js';

interface PutResourceResult {
  entry: { uri: string; size: number; mimeType: string; expiresAt: string };
  link: ContentBlock;
}

export function buildFileResourceLink(
  validPath: string,
  mimeType: string,
  size: number,
): ContentBlock {
  return {
    type: 'resource_link',
    uri: buildFileResourceUri(validPath),
    name: basename(validPath),
    mimeType,
    size,
    annotations: { audience: ['user', 'assistant'] },
  };
}

/**
 * Owner of the externalize-a-payload rule: a tool whose inline response is
 * truncated publishes the full value to the resource store as pretty-printed
 * JSON and hands back the URI to reach it by, plus the link block that offers
 * it to the user.
 */
export function putJsonResource(
  store: ResourceStore,
  name: string,
  // `object`, not `unknown`: JSON.stringify returns undefined for undefined and
  // for a function while TypeScript types the result `string`, which would put
  // a non-string into the store's text entry.
  value: object,
): PutResourceResult {
  const entry = store.putText({
    name,
    mimeType: 'application/json',
    text: JSON.stringify(value, null, 2),
  });

  return {
    entry: {
      uri: entry.uri,
      size: entry.size,
      mimeType: entry.mimeType,
      expiresAt: entry.expiresAt,
    },
    link: {
      type: 'resource_link',
      uri: entry.uri,
      name: entry.name,
      mimeType: entry.mimeType,
      size: entry.size,
      annotations: { audience: ['user'] },
    },
  };
}

interface FileInfoPayload {
  name: string;
  path: string;
  type: FileInfo['type'];
  size: number;
  tokenEstimate?: number;
  created: string;
  modified: string;
  accessed: string;
  permissions: string;
  isHidden: boolean;
  mimeType?: string;
  symlinkTarget?: string;
}

export function buildFileInfoPayload(info: FileInfo): FileInfoPayload {
  return {
    name: info.name,
    path: info.path,
    type: info.type,
    size: info.size,
    ...(info.tokenEstimate !== undefined ? { tokenEstimate: info.tokenEstimate } : {}),
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    accessed: info.accessed.toISOString(),
    permissions: info.permissions,
    isHidden: info.isHidden,
    ...(info.mimeType !== undefined ? { mimeType: info.mimeType } : {}),
    ...(info.symlinkTarget !== undefined ? { symlinkTarget: info.symlinkTarget } : {}),
  };
}
