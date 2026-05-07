import { z } from 'zod/v4';

import { FileType, NonNegInt } from '../fields.js';

const TreeNodeSchema: z.ZodType = z.strictObject({
  path: z.string().describe('Path relative to root'),
  type: FileType,
  size: NonNegInt.optional(),
  children: z.lazy(() => TreeNodeSchema.array()).optional(),
});

export const TreeOutputSchema = z.strictObject({
  ok: z.literal(true),
  root: z.string().optional(),
  tree: z
    .array(
      z.strictObject({
        path: z.string().describe('Path relative to root'),
        type: FileType,
        size: NonNegInt.optional(),
        children: z.lazy(() => TreeNodeSchema.array()).optional(),
      })
    )
    .optional(),
});
