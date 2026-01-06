import { z } from 'zod';

import { FileTypeSchema } from './file-type-schema.js';

export const TraversalSummarySchema = z.object({
  totalFiles: z.number(),
  totalDirectories: z.number(),
  maxDepthReached: z.number().optional(),
  truncated: z.boolean(),
  stoppedReason: z
    .enum(['maxEntries', 'aborted'])
    .optional()
    .describe('Reason traversal stopped early'),
  skippedInaccessible: z.number().optional(),
  symlinksNotFollowed: z
    .number()
    .optional()
    .describe(
      'Number of symbolic links encountered but not followed (for security)'
    ),
  entriesScanned: z
    .number()
    .optional()
    .describe('Total number of directory entries scanned before filtering'),
  entriesVisible: z
    .number()
    .optional()
    .describe('Entries remaining after hidden/exclude filters'),
});

export const BatchSummarySchema = z.object({
  total: z.number(),
  succeeded: z.number(),
  failed: z.number(),
});

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
