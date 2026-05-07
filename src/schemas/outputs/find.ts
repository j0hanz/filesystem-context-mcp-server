import { z } from 'zod/v4';

import { IsoDateTime, NonNegInt, StoppedReason } from '../fields.js';
import { NextCursorSchema } from '../pagination.js';
import { SearchSummarySchema } from '../shared.js';

export const SearchFilesOutputSchema = SearchSummarySchema.extend({
  ok: z.literal(true),
  root: z.string().optional().describe('Search root'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('Relative path'),
        size: NonNegInt.optional(),
        modified: IsoDateTime.optional(),
      })
    )
    .optional(),
  filesScanned: NonNegInt.optional().describe('Files scanned'),
  skippedInaccessible: NonNegInt.optional().describe('Inaccessible files'),
  stoppedReason: StoppedReason.optional().describe('Why search stopped'),
  nextCursor: NextCursorSchema,
});
