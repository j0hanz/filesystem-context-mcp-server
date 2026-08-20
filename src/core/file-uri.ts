// Single owner of the `filesystem-mcp://file/` URI scheme: the template string,
// the path→URI encoder, and the URI→path decoder.

export const FILESYSTEM_FILE_URI_TEMPLATE = 'filesystem-mcp://file/{+path}';

export function buildFileResourceUri(validPath: string): string {
  const posix = validPath.replace(/\\/g, '/');
  // Percent-encode so extractPath's decodeURIComponent round-trips.
  // Unescaped, a '#' or '?' in a filename truncates the URI into a fragment or
  // query (silently naming a different path) and a '%' makes the decode throw.
  // Separators are restored so the {+path} template still reads as a path.
  return `filesystem-mcp://file/${encodeURIComponent(posix).replace(/%2F/gi, '/')}`;
}

export function extractPath(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'filesystem-mcp:' || url.host !== 'file') return undefined;
    return decodeURIComponent(url.pathname.slice(1));
  } catch {
    return undefined;
  }
}
