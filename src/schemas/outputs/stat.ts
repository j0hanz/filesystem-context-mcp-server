import { z } from 'zod/v4';

import { FileInfoSchema } from '../shared.js';

export const StatOutputSchema = z.strictObject({
  ok: z.literal(true),
  info: FileInfoSchema.describe('File metadata'),
});
