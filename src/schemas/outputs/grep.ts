import { z } from 'zod/v4';

import { NonNegInt, StoppedReason } from '../fields.js';
import { NextCursorSchema } from '../pagination.js';
import { SearchSummarySchema } from '../shared.js';

export const GrepOutputSchema = SearchSummarySchema.extend({
  ok: z.literal(true),
  root: z.string().optional().describe('Search root'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        line: NonNegInt.describe('Line number (1-indexed)'),
        text: z.string().describe('Matching line text'),
        column: NonNegInt.optional().describe('Column of match'),
      })
    )
    .optional(),
  filesScanned: NonNegInt.optional().describe('Files scanned'),
  filesMatched: NonNegInt.optional().describe('Files with matches'),
  skippedInaccessible: NonNegInt.optional().describe('Inaccessible files'),
  stoppedReason: StoppedReason.optional().describe('Why search stopped'),
  nextCursor: NextCursorSchema,
});
