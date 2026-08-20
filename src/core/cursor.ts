import * as z from 'zod/v4';

import { ErrorCode, formatUnknownErrorMessage, FsError } from './errors.js';

const OffsetCursorSchema = z.strictObject({
  offset: z.int().nonnegative(),
});

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
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
