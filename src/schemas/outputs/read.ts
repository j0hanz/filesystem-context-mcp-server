import { z } from 'zod';

import { ErrorSchema } from '../error-schema.js';
import { BatchSummarySchema } from '../output-helpers.js';

export const ReadFileOutputSchema = z.object({
  ok: z.boolean(),
  path: z.string().optional(),
  content: z.string().optional(),
  truncated: z.boolean().optional(),
  totalLines: z.number().optional(),
  readMode: z.enum(['full', 'head', 'tail', 'lineRange']).optional(),
  lineStart: z.number().optional(),
  lineEnd: z.number().optional(),
  head: z.number().optional(),
  tail: z.number().optional(),
  linesRead: z.number().optional(),
  hasMoreLines: z.boolean().optional(),
  effectiveOptions: z
    .object({
      encoding: z.string(),
      maxSize: z.number(),
      skipBinary: z.boolean(),
      lineStart: z.number().optional(),
      lineEnd: z.number().optional(),
      head: z.number().optional(),
      tail: z.number().optional(),
    })
    .optional(),
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
        readMode: z.enum(['full', 'head', 'tail', 'lineRange']).optional(),
        lineStart: z.number().optional(),
        lineEnd: z.number().optional(),
        head: z.number().optional(),
        tail: z.number().optional(),
        linesRead: z.number().optional(),
        hasMoreLines: z.boolean().optional(),
        error: z.string().optional(),
      })
    )
    .optional(),
  summary: BatchSummarySchema.optional(),
  effectiveOptions: z
    .object({
      encoding: z.string(),
      maxSize: z.number(),
      maxTotalSize: z.number(),
      head: z.number().optional(),
      tail: z.number().optional(),
      lineStart: z.number().optional(),
      lineEnd: z.number().optional(),
    })
    .optional(),
  error: ErrorSchema.optional(),
});
