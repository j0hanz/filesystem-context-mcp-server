import { z } from 'zod';

import {
  IncludeHiddenSchema,
  isSafeGlobPattern,
  ListExcludePatternsSchema,
  MaxDepthSchema,
  MaxEntriesSchema,
  SortByDirectorySchema,
} from '../input-helpers.js';

export const ListDirectoryInputSchema = {
  path: z
    .string()
    .min(1, 'Path cannot be empty')
    .describe('Absolute or relative path to the directory to list'),
  recursive: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'If true, list contents of subdirectories recursively up to maxDepth'
    ),
  includeHidden: IncludeHiddenSchema,
  excludePatterns: ListExcludePatternsSchema.describe(
    'Glob patterns to exclude (e.g., "node_modules/**")'
  ),
  maxDepth: MaxDepthSchema.describe(
    'Maximum depth for recursive listing (higher values may impact performance)'
  ),
  maxEntries: MaxEntriesSchema,
  sortBy: SortByDirectorySchema,
  includeSymlinkTargets: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include symlink target paths for symbolic links'),
  pattern: z
    .string()
    .min(1, 'Pattern cannot be empty')
    .max(1000, 'Pattern is too long (max 1000 characters)')
    .refine(isSafeGlobPattern, {
      message:
        'Pattern must be relative (no absolute paths or ".." segments allowed)',
    })
    .optional()
    .describe('Glob pattern to include (e.g., "**/*.ts")'),
};
