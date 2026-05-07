import { z } from 'zod/v4';

import { RequiredPath } from '../fields.js';

export const StatManyInputSchema = z.strictObject({
  paths: z
    .array(RequiredPath)
    .min(1, 'At least 1 path required')
    .describe('Paths to stat'),
});
