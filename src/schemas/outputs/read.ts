import { z } from 'zod';

import { ErrorSchema } from '../common.js';
import { BatchSummarySchema } from '../output-helpers.js';

export const ReadFileOutputSchema = z.object({
  ok: z.boolean(),
  path: z.string().optional(),
  content: z.string().optional(),
  truncated: z.boolean().optional(),
  totalLines: z.number().optional(),
  error: ErrorSchema.optional(),
});

export const ReadMultipleFilesOutputSchema = z.object({
  ok: z.boolean(),
  results: z
    .array(
      z.object({
        path: z.string(),
        content: z.string().optional(),
        truncated: z.boolean().optional(),
        totalLines: z.number().optional(),
        error: z.string().optional(),
      })
    )
    .optional(),
  summary: BatchSummarySchema.optional(),
  error: ErrorSchema.optional(),
});
