import * as z from 'zod/v4';

import { ErrorCode, formatUnknownErrorMessage, FsError } from './errors.js';

const OffsetCursorSchema = z.strictObject({
  offset: z.int().nonnegative(),
});

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
}

/**
 * Owner of the offset-page rule: decode the incoming cursor and derive how many
 * results the underlying query must fetch to reach the end of this page.
 * `max` is the query's own hard cap, which the fetch may never exceed.
 *
 * Named rather than positional for the same reason as {@link closePage}: the
 * numeric arguments are interchangeable to the compiler and not to the caller.
 */
export function openPage(params: { cursor: string | undefined; pageSize: number; max: number }): {
  offset: number;
  fetchMax: number;
} {
  const { cursor, pageSize, max } = params;
  const offset = cursor !== undefined ? decodeOffsetCursor(cursor) : 0;
  return { offset, fetchMax: Math.min(offset + pageSize, max) };
}

/**
 * The other half of {@link openPage}: a cursor for the next page, or undefined
 * when there is none. A truncated scan that yielded nothing on this page has no
 * further page to point at — issuing a cursor there would loop the caller.
 */
export function closePage(params: {
  truncated: boolean;
  offset: number;
  pageCount: number;
}): string | undefined {
  const { truncated, offset, pageCount } = params;
  return truncated && pageCount > 0 ? encodeOffsetCursor(offset + pageCount) : undefined;
}

export function decodeOffsetCursor(cursor: string): number {
  // Every failure mode — bad base64url, invalid UTF-8, malformed JSON, wrong
  // shape — is the same thing to a caller: this cursor is not one we issued.
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf-8');
    return OffsetCursorSchema.parse(JSON.parse(text)).offset;
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
