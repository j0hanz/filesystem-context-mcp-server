import { z } from 'zod/v4';

import { NonNegInt } from '../fields.js';

export const EditFileOutputSchema = z.strictObject({
  ok: z.literal(true),
  path: z.string().describe('File path'),
  editsApplied: NonNegInt.describe('Number of edits applied'),
  size: NonNegInt.optional().describe('New file size (bytes)'),
});
