import { z } from 'zod';

import { ErrorSchema } from '../common.js';

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
  summary: z
    .object({
      total: z.number(),
      succeeded: z.number(),
      failed: z.number(),
    })
    .optional(),
  error: ErrorSchema.optional(),
});

export const ReadMediaFileOutputSchema = z.object({
  ok: z.boolean(),
  path: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  data: z.string().optional(),
  error: ErrorSchema.optional(),
});
