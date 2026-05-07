import { z } from 'zod/v4';

import { OptionalPath } from '../fields.js';

export const HashInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'File path (relative to first root if multiple roots)'
  ),
});
