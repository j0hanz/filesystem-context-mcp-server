import { z } from 'zod/v4';

import { RequiredPath } from '../fields.js';

export const DeleteInputSchema = z.strictObject({
  path: RequiredPath.describe('Path to delete (file or directory)'),
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe('Force delete (bypass safety checks)'),
});
