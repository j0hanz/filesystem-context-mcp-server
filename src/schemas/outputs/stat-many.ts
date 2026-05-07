import { z } from 'zod/v4';

import { NonNegInt } from '../fields.js';
import { FileInfoSchema } from '../shared.js';

export const StatManyOutputSchema = z.strictObject({
  ok: z.literal(true),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('Requested path'),
        info: FileInfoSchema.optional().describe('File metadata (if succeeded)'),
      })
    )
    .optional(),
  totalSucceeded: NonNegInt.optional().describe('Successful stats'),
  totalFailed: NonNegInt.optional().describe('Failed stats'),
});
