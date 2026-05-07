import { z } from 'zod/v4';

import { NonNegInt } from '../fields.js';

export const WriteFileOutputSchema = z.strictObject({
  ok: z.literal(true),
  path: z.string().describe('File path'),
  size: NonNegInt.describe('File size (bytes)'),
});
