import { z } from 'zod';

import { ErrorSchema } from '../common.js';
import { FileInfoSchema } from '../output-helpers.js';

export const GetFileInfoOutputSchema = z.object({
  ok: z.boolean(),
  info: FileInfoSchema.optional(),
  error: ErrorSchema.optional(),
});

export const GetMultipleFileInfoOutputSchema = z.object({
  ok: z.boolean(),
  results: z
    .array(
      z.object({
        path: z.string(),
        info: FileInfoSchema.optional(),
        error: z.string().optional(),
      })
    )
    .optional(),
  summary: z
    .object({
      total: z.number(),
      succeeded: z.number(),
      failed: z.number(),
      totalSize: z
        .number()
        .describe('Total size of all successfully read files'),
    })
    .optional(),
  error: ErrorSchema.optional(),
});
