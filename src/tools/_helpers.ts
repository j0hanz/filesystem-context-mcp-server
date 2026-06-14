import type { ContentBlock, Role } from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import { ErrorCode, FsError } from '../core/errors.js';
import type { FileInfo, MimeKind } from '../core/fs.js';
import { createBase64JsonCodec } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { NonNegInt } from '../schema.js';

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

// ============ Cursor Helpers ============

const OffsetCursorSchema = z.strictObject({
  offset: NonNegInt,
});

const OffsetCursorCodec = createBase64JsonCodec(OffsetCursorSchema);

export function encodeOffsetCursor(offset: number): string {
  return z.encode(OffsetCursorCodec, { offset });
}

export function decodeOffsetCursor(cursor: string): number {
  // safeParse normally reports failure via result.success, but a codec decode can
  // also throw; treat either as an invalid cursor with one uniform error.
  let result: ReturnType<typeof OffsetCursorCodec.safeParse> | undefined;
  try {
    result = OffsetCursorCodec.safeParse(cursor);
  } catch {
    result = undefined;
  }
  if (!result?.success) {
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      `Invalid cursor. Request the first page without a cursor.`,
    );
  }
  return result.data.offset;
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
