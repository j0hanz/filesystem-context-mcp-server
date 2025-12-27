import { z } from 'zod';

import { ErrorSchema } from '../common.js';
import { BatchSummarySchema } from '../output-helpers.js';

export const ComputeChecksumsOutputSchema = z.object({
  ok: z.boolean(),
  results: z
    .array(
      z.object({
        path: z.string(),
        checksum: z.string().optional(),
        algorithm: z.string(),
        size: z.number().optional(),
        error: z.string().optional(),
      })
    )
    .optional(),
  summary: BatchSummarySchema.optional(),
  error: ErrorSchema.optional(),
});
