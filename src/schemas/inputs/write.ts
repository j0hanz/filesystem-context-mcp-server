import { z } from 'zod/v4';

import { OptionalPath } from '../fields.js';

export const WriteFileInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'File path (relative to first root if multiple roots)'
  ),
  content: z.string().describe('File content to write'),
});
