import { z } from 'zod/v4';

import { RequiredPath } from '../fields.js';

// NOTE: singular `source` is intentionally removed (breaking change).
// Callers must use `sources: ["/single/source"]` for single-file moves.
export const MoveFileInputSchema = z.strictObject({
  sources: z
    .array(RequiredPath)
    .min(1, 'Min 1 source required')
    .describe('Paths to move'),
  destination: RequiredPath.describe('New path'),
});
