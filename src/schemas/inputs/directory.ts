import { z } from 'zod';

import {
  AnalyzeMaxEntriesSchema,
  BasicExcludePatternsSchema,
  IncludeHiddenSchema,
  isSafeGlobPattern,
  MaxDepthSchema,
  MaxEntriesSchema,
  SortByDirectorySchema,
  TopNSchema,
  TreeMaxDepthSchema,
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
  excludePatterns: z
    .array(
      z
        .string()
        .max(500, 'Individual exclude pattern is too long')
        .refine((val) => !val.includes('**/**/**'), {
          message: 'Pattern too deeply nested (max 2 levels of **)',
        })
    )
    .max(100, 'Too many exclude patterns (max 100)')
    .optional()
    .default([])
    .describe('Glob patterns to exclude (e.g., "node_modules/**")'),
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

export const AnalyzeDirectoryInputSchema = {
  path: z
    .string()
    .min(1, 'Path cannot be empty')
    .describe('Directory to analyze'),
  maxDepth: MaxDepthSchema.describe('Maximum depth to analyze'),
  topN: TopNSchema,
  maxEntries: AnalyzeMaxEntriesSchema.describe(
    'Maximum number of entries (files + directories) to scan'
  ),
  excludePatterns: BasicExcludePatternsSchema.describe(
    'Glob patterns to exclude (e.g., "node_modules", "*.log")'
  ),
  includeHidden: IncludeHiddenSchema,
};

export const DirectoryTreeInputSchema = {
  path: z
    .string()
    .min(1, 'Path cannot be empty')
    .describe('Directory path to build tree from'),
  maxDepth: TreeMaxDepthSchema,
  excludePatterns: BasicExcludePatternsSchema.describe(
    'Glob patterns to exclude (e.g., "node_modules", "*.log")'
  ),
  includeHidden: IncludeHiddenSchema,
  includeSize: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include file sizes in the tree'),
  maxFiles: z
    .number()
    .int('maxFiles must be an integer')
    .min(1, 'maxFiles must be at least 1')
    .max(100000, 'maxFiles cannot exceed 100,000')
    .optional()
    .describe('Maximum total number of files to include in the tree'),
};
