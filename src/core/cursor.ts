import { ErrorCode, formatUnknownErrorMessage, FsError } from './errors.js';

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
}

/**
 * Owner of the offset-page rule: decode the incoming cursor and derive the
 * fetch window for this page. Every page re-runs the underlying query and sorts
 * the result before slicing, so every page MUST sort the same universe —
 * otherwise successive pages sort different populations and overlap/skip
 * matches. That means the fetch has to cover the full result set up to the
 * query's hard cap `max`, not just the end of this page: `fetchMax = max`.
 *
 * (Capping at `offset + pageSize` would only be safe if the underlying scan
 * yielded in sorted order; it yields in readdir order, so a per-page cap
 * slices a different, unsorted prefix each time.)
 *
 * The page itself is bounded by `pageSize` later, in {@link closePage}'s caller
 * via `slice(offset, offset + pageSize)`; `fetchMax` is only the scan cap.
 *
 * ponytail: every page re-scans to `max` and re-sorts — O(max) per page, not
 * O(offset+pageSize). A ~100x work increase for page 1 over the old per-page
 * cap, but the old cap sorted a different readdir prefix each page (overlap/
 * skip). If per-page re-scan shows up in a profile, cache the page-1 sorted
 * set (the resource store already persists it) and serve later pages from it
 * by cursor instead of re-scanning.
 */
export function openPage(params: { cursor: string | undefined; max: number }): {
  offset: number;
  fetchMax: number;
} {
  const { cursor, max } = params;
  const offset = cursor !== undefined ? decodeOffsetCursor(cursor) : 0;
  return { offset, fetchMax: max };
}

/**
 * The other half of {@link openPage}: a cursor for the next page, or undefined
 * when there is none. `total` is the size of the full set this page sorted
 * (the scan's capped result count, the same every page); a next page exists
 * while this page did not reach the end of it. A page that yielded nothing is
 * already at or past the end (`offset >= total`), so it naturally gets no
 * cursor — issuing one there would loop the caller.
 */
export function closePage(params: {
  total: number;
  offset: number;
  pageCount: number;
}): string | undefined {
  const { total, offset, pageCount } = params;
  return offset + pageCount < total ? encodeOffsetCursor(offset + pageCount) : undefined;
}

export function decodeOffsetCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(text) as { offset?: unknown };
    if (
      typeof parsed.offset === 'number' &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0
    ) {
      return parsed.offset;
    }
    throw new Error('Invalid offset');
  } catch (error) {
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      'Invalid cursor. Request the first page without a cursor.',
      undefined,
      { originalError: formatUnknownErrorMessage(error) },
      error instanceof Error ? error : undefined,
    );
  }
}
