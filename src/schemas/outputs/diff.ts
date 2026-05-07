import { z } from 'zod/v4';

import { NonNegInt } from '../fields.js';

export const DiffFilesOutputSchema = z.strictObject({
  ok: z.literal(true),
  diff: z.string().describe('Unified diff output'),
  linesAdded: NonNegInt.optional().describe('Lines added'),
  linesRemoved: NonNegInt.optional().describe('Lines removed'),
});
