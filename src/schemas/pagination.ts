import { z } from 'zod/v4';

// Opaque base-64 JSON cursor — treat as opaque; do not parse or construct manually.
// Format: base64(JSON.stringify({ offset: number }))
export const CursorSchema = z
  .string()
  .optional()
  .describe('Pagination cursor from a previous response. Treat as opaque.');

export const NextCursorSchema = z
  .string()
  .optional()
  .describe('Cursor for the next page; absent on the final page.');
