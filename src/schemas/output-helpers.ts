import { z } from 'zod';

import { FileTypeSchema } from './file-type-schema.js';

export const FileInfoSchema = z.object({
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
});

export const OperationSummarySchema = z.object({
  total: z.number(),
  succeeded: z.number(),
  failed: z.number(),
});
