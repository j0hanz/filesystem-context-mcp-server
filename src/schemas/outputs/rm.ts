import { z } from 'zod/v4';

import { NonNegInt } from '../fields.js';

export const DeleteOutputSchema = z.strictObject({
  ok: z.literal(true),
  path: z.string().describe('Deleted path'),
  filesDeleted: NonNegInt.optional().describe('Files deleted'),
  directoriesDeleted: NonNegInt.optional().describe('Directories deleted'),
});
