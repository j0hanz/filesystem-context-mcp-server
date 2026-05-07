import { z } from 'zod/v4';

import { NonNegInt } from '../fields.js';
import { OperationSummarySchema } from '../shared.js';

export const ApplyPatchOutputSchema = z.strictObject({
  ok: z.literal(true),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        summary: OperationSummarySchema.optional().describe(
          'Hunks attempted/applied'
        ),
      })
    )
    .optional(),
  totalHunksApplied: NonNegInt.optional().describe('Total hunks applied'),
  totalHunksFailed: NonNegInt.optional().describe('Total hunks failed'),
});
