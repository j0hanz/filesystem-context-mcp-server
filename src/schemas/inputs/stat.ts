import { z } from 'zod/v4';

import { OptionalPath } from '../fields.js';

export const StatInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'File or directory path (relative to first root if multiple roots)'
  ),
});
