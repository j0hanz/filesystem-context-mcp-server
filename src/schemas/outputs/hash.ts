import { z } from 'zod/v4';

import { Sha256Hex } from '../fields.js';

export const HashOutputSchema = z.strictObject({
  ok: z.literal(true),
  path: z.string().describe('File path'),
  hash: Sha256Hex.describe('SHA-256 hash'),
});
