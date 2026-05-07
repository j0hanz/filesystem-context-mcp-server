import { z } from 'zod/v4';

import { RequiredPath } from '../fields.js';

export const DiffFilesInputSchema = z.strictObject({
  paths: z
    .array(RequiredPath)
    .min(2, 'At least 2 paths required')
    .max(2, 'Exactly 2 paths supported')
    .describe('Two file paths to compare'),
});
