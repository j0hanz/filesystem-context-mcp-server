import { z } from 'zod';

import { ErrorSchema, FileTypeSchema } from '../common.js';

export const GetFileInfoOutputSchema = z.object({
  ok: z.boolean(),
  info: z
    .object({
      name: z.string(),
      path: z.string(),
      type: FileTypeSchema,
      size: z.number(),
      created: z.string().optional(),
      modified: z.string(),
      accessed: z.string().optional(),
      permissions: z.string(),
      isHidden: z.boolean().optional(),
      mimeType: z.string().optional(),
      symlinkTarget: z.string().optional(),
    })
    .optional(),
  error: ErrorSchema.optional(),
});

export const GetMultipleFileInfoOutputSchema = z.object({
  ok: z.boolean(),
  results: z
    .array(
      z.object({
        path: z.string(),
        info: z
          .object({
            name: z.string(),
            path: z.string(),
            type: FileTypeSchema,
            size: z.number(),
            created: z.string().optional(),
            modified: z.string(),
            accessed: z.string().optional(),
            permissions: z.string(),
            isHidden: z.boolean().optional(),
            mimeType: z.string().optional(),
            symlinkTarget: z.string().optional(),
          })
          .optional(),
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
