import { z } from 'zod/v4';

import { OptionalPath } from '../fields.js';

export const ApplyPatchInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'Base directory for patch application (relative to first root if multiple roots)'
  ),
  patch: z.string().min(1, 'Patch required').describe('Unified diff patch'),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe('Preview changes without applying'),
});
