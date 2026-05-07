import { z } from 'zod/v4';

// Opaque base-64 JSON cursor — treat as opaque; do not parse or construct manually.
// `ls` cursors are snapshot-backed (5 min TTL, expire on eviction/restart).
// `find` cursors are offset-based (re-runs the query on each page request).
export const CursorSchema = z
  .base64url()
  .optional()
  .describe(
    'Pagination cursor from a previous response. Treat as opaque. ' +
      '`ls` cursors are snapshot-backed (expire after ~5 min or restart); ' +
      '`find` cursors are offset-based and re-run the query each page.'
  );

export const NextCursorSchema = z
  .base64url()
  .optional()
  .describe('Cursor for the next page; absent on the final page.');
