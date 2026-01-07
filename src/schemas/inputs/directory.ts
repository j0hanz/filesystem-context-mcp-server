import { z } from 'zod';

import { ListExcludePatternsSchema } from '../input-helpers.js';

export const ListDirectoryInputSchema = z.strictObject({
  path: z
    .string()
    .min(1, 'Path cannot be empty')
    .describe('Absolute or relative path to the directory to list'),
  recursive: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, list contents of subdirectories recursively'),
  excludePatterns: ListExcludePatternsSchema.describe(
    'Glob patterns to exclude (e.g., "node_modules/**")'
  ),
});
