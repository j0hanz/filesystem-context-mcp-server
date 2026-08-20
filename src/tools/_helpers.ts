import type { ContentBlock, Role } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import { buildFileResourceUri } from '../core/file-uri.js';
import type { FileInfo } from '../core/fs.js';
import type { MimeKind } from '../core/mime.js';
import type { ResourceStore } from '../core/store.js';

// ============ Resource Store Helpers ============

interface PutResourceParams {
  store: ResourceStore;
  name: string;
  mimeType: string;
  kind: MimeKind;
  content: string | Buffer;
  audience?: Role[];
  title?: string;
  description?: string;
}

interface PutResourceResult {
  entry: { uri: string; size: number; mimeType: string; expiresAt: string };
  link: ContentBlock;
}

function buildLinkBlock(
  uri: string,
  name: string,
  mimeType: string,
  size: number,
  params?: {
    audience?: Role[];
    title?: string;
    description?: string;
  },
): ContentBlock {
  const audience = params?.audience ?? ['user'];
  return {
    type: 'resource_link',
    uri,
    name,
    mimeType,
    size,
    ...(params?.title ? { title: params.title } : {}),
    ...(params?.description ? { description: params.description } : {}),
    annotations: { audience },
  };
}

// ============ File Resource Link Helpers ============

export function buildFileResourceLink(
  validPath: string,
  mimeType: string,
  size: number,
): ContentBlock {
  return buildLinkBlock(buildFileResourceUri(validPath), basename(validPath), mimeType, size, {
    audience: ['user', 'assistant'],
  });
}

export function putResource(params: PutResourceParams): PutResourceResult {
  const entry =
    params.kind === 'text'
      ? params.store.putText({
          name: params.name,
          mimeType: params.mimeType,
          text:
            typeof params.content === 'string' ? params.content : params.content.toString('utf-8'),
        })
      : params.store.putBlob({
          name: params.name,
          mimeType: params.mimeType,
          data: Buffer.isBuffer(params.content) ? params.content : Buffer.from(params.content),
        });

  const linkParams = {
    ...(params.audience !== undefined ? { audience: params.audience } : {}),
    ...(params.title !== undefined ? { title: params.title } : {}),
    ...(params.description !== undefined ? { description: params.description } : {}),
  };

  const link = buildLinkBlock(entry.uri, entry.name, entry.mimeType, entry.size, linkParams);

  return {
    entry: {
      uri: entry.uri,
      size: entry.size,
      mimeType: entry.mimeType,
      expiresAt: entry.expiresAt,
    },
    link,
  };
}

// ============ FileInfo Helper ============

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
