import { z } from 'zod/v4';

import { ReadResultSchema } from '../shared.js';

export const ReadFileOutputSchema = ReadResultSchema.extend({
  ok: z.literal(true),
  path: z.string().describe('File path'),
});
