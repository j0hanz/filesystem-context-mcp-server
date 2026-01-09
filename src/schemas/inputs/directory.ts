import { z } from 'zod';

import { isSafeGlobPattern } from './helpers.js';

export const ListDirectoryInputSchema = z.strictObject({
  path: z
    .string()
    .optional()
    .describe(
      'Directory path to list (leave empty for workspace root). ' +
        'Examples: "src", "src/components", "lib/utils"'
    ),
  includeHidden: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include hidden files and directories'),
  excludePatterns: z
    .array(
      z
        .string()
        .min(1, 'Exclude pattern cannot be empty')
        .max(500, 'Exclude pattern is too long')
        .refine(isSafeGlobPattern, {
          error:
            'Exclude pattern must be relative (no absolute or ".." segments)',
        })
    )
    .max(100, 'Too many exclude patterns (max 100)')
    .optional()
    .default([])
    .describe('Glob patterns to exclude'),
  pattern: z
    .string()
    .min(1, 'Pattern cannot be empty')
    .max(1000, 'Pattern is too long (max 1000 characters)')
    .optional()
    .refine((value) => value === undefined || isSafeGlobPattern(value), {
      error: 'Pattern must be relative (no absolute or ".." segments)',
    })
    .describe('Glob pattern to include (relative, no "..")'),
  maxDepth: z
    .number()
    .int({ error: 'maxDepth must be an integer' })
    .min(0, 'maxDepth must be at least 0')
    .max(100, 'maxDepth cannot exceed 100')
    .optional()
    .default(10)
    .describe('Maximum depth when using pattern (0-100)'),
  maxEntries: z
    .number()
    .int({ error: 'maxEntries must be an integer' })
    .min(1, 'maxEntries must be at least 1')
    .max(100000, 'maxEntries cannot exceed 100,000')
    .optional()
    .default(10000)
    .describe('Maximum entries to return (1-100000)'),
  timeoutMs: z
    .number()
    .int({ error: 'timeoutMs must be an integer' })
    .min(100, 'timeoutMs must be at least 100ms')
    .max(3600000, 'timeoutMs cannot exceed 1 hour')
    .optional()
    .default(30000)
    .describe('Timeout in milliseconds'),
  sortBy: z
    .enum(['name', 'size', 'modified', 'type'])
    .optional()
    .default('name')
    .describe('Sort by: name, size, modified, type'),
  includeSymlinkTargets: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include symlink target paths (symlinks are not followed)'),
});
