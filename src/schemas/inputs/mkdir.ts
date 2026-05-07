import { z } from 'zod/v4';

import { RequiredPath } from '../fields.js';

// NOTE: singular `path` is intentionally removed (breaking change).
// Callers must use `paths: ["/single/path"]` for single-directory creation.
export const CreateDirectoryInputSchema = z.strictObject({
  paths: z
    .array(RequiredPath)
    .min(1, 'Min 1 path required')
    .describe('Absolute paths to directories to create'),
});
