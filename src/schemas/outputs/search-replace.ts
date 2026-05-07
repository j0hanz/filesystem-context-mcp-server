import { z } from 'zod/v4';

import { NonNegInt, StoppedReason } from '../fields.js';
import { NextCursorSchema } from '../pagination.js';
import { OperationSummarySchema, SearchSummarySchema } from '../shared.js';

export const SearchAndReplaceOutputSchema = SearchSummarySchema.extend({
  ok: z.literal(true),
  root: z.string().optional().describe('Search root'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        matched: OperationSummarySchema.optional().describe(
          'Match counts'
        ),
        applied: OperationSummarySchema.optional().describe(
          'Replacement counts'
        ),
      })
    )
    .optional(),
  filesScanned: NonNegInt.optional().describe('Files scanned'),
  filesMatched: NonNegInt.optional().describe('Files with matches'),
  filesModified: NonNegInt.optional().describe('Files modified'),
  skippedInaccessible: NonNegInt.optional().describe('Inaccessible files'),
  stoppedReason: StoppedReason.optional().describe('Why search stopped'),
  nextCursor: NextCursorSchema,
});
