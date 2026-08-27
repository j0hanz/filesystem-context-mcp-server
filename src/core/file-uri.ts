import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

// Single owner of the `filesystem-mcp://file/` URI scheme: the template string,
// the path→URI encoder, and the URI→path decoder.

export const FILESYSTEM_FILE_URI_TEMPLATE = 'filesystem-mcp://file/{+path}';

/**
 * The `{+path}` template-variable form of a path — what `completion/complete`
 * must return, since a client expands a suggestion into the template verbatim.
 * Unescaped, a '#' or '?' in a filename truncates the URI into a fragment or
 * query (silently naming a different path) and a '%' makes the decode throw.
 * Separators are restored so the value still reads as a path.
 */
export function encodeFileUriPath(validPath: string): string {
  const posix = validPath.replace(/\\/g, '/');
  return encodeURIComponent(posix).replace(/%2F/gi, '/');
}

/** Inverse of {@link encodeFileUriPath}; `undefined` on invalid percent-encoding. */
export function decodeFileUriPath(encoded: string): string | undefined {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

export function buildFileResourceUri(validPath: string): string {
  return `filesystem-mcp://file/${encodeFileUriPath(validPath)}`;
}

/**
 * The link block for a URI already built by `buildFileResourceUri`. Callers that
 * hold the URI must use this rather than rebuilding from a path: a path that
 * differs only in case (the drive letter, on Windows) yields a *different* URI
 * string, and watchers key on that string — a link and a `resourceUri` that
 * disagree hand the client two subscriptions for one file.
 */
export function buildFileResourceLinkFor(
  uri: string,
  name: string,
  mimeType: string,
  size: number,
  annotations: Record<string, unknown> = { audience: ['user', 'assistant'] },
): ContentBlock {
  return { type: 'resource_link', uri, name, mimeType, size, annotations };
}

export function buildFileResourceLink(
  validPath: string,
  mimeType: string,
  size: number,
  annotations: Record<string, unknown> = { audience: ['user', 'assistant'] },
): ContentBlock {
  return buildFileResourceLinkFor(
    buildFileResourceUri(validPath),
    basename(validPath),
    mimeType,
    size,
    annotations,
  );
}

export function extractPath(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'filesystem-mcp:' || url.host !== 'file') return undefined;
    return decodeFileUriPath(url.pathname.slice(1));
  } catch {
    return undefined;
  }
}
