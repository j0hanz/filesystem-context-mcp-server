import { z } from 'zod/v4';

import { OptionalPath } from '../fields.js';

export const EditFileInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'File path (relative to first root if multiple roots)'
  ),
  edits: z
    .array(
      z.strictObject({
        oldText: z
          .string()
          .describe('Exact text to find and replace'),
        newText: z.string().describe('Replacement text'),
      })
    )
    .min(1, 'At least 1 edit required')
    .describe('Edits to apply'),
});
