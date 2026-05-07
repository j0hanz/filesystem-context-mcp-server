import { z } from 'zod/v4';

import { NonNegInt } from '../fields.js';
import { ReadResultSchema } from '../shared.js';

export const ReadManyOutputSchema = z.strictObject({
  ok: z.literal(true),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        ...ReadResultSchema.shape,
      })
    )
    .optional(),
  totalSucceeded: NonNegInt.optional().describe('Successful reads'),
  totalFailed: NonNegInt.optional().describe('Failed reads'),
});
