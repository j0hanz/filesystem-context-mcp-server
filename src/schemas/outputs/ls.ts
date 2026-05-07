import { z } from 'zod/v4';

import { FileType, IsoDateTime, NonNegInt, StoppedReason } from '../fields.js';
import { NextCursorSchema } from '../pagination.js';

export const ListDirectoryOutputSchema = z.strictObject({
  ok: z.literal(true),
  path: z.string().optional(),
  entries: z
    .array(
      z.strictObject({
        name: z.string().describe('Entry name'),
        relativePath: z.string().optional(),
        type: FileType,
        size: NonNegInt.optional(),
        modified: IsoDateTime.optional(),
      })
    )
    .optional(),
  totalEntries: NonNegInt.optional(),
  truncated: z.boolean().optional(),
  totalFiles: NonNegInt.optional(),
  totalDirectories: NonNegInt.optional(),
  stoppedReason: StoppedReason.optional(),
  skippedInaccessible: NonNegInt.optional(),
  nextCursor: NextCursorSchema,
});
