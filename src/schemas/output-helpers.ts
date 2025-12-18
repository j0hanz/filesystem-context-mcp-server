import { z } from 'zod';

export const TraversalSummarySchema = z.object({
  totalFiles: z.number(),
  totalDirectories: z.number(),
  maxDepthReached: z.number().optional(),
  truncated: z.boolean(),
  skippedInaccessible: z.number().optional(),
  symlinksNotFollowed: z
    .number()
    .optional()
    .describe(
      'Number of symbolic links encountered but not followed (for security)'
    ),
});
