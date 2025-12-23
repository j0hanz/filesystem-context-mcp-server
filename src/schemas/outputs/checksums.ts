import { z } from 'zod';

import { ErrorSchema } from '../common.js';

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
  summary: z
    .object({
      total: z.number(),
      succeeded: z.number(),
      failed: z.number(),
    })
    .optional(),
  error: ErrorSchema.optional(),
});
