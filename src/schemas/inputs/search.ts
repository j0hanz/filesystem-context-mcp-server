import { z } from 'zod';

import {
  CaseSensitiveSchema,
  ExcludePatternsSchema,
  isSafeGlobPattern,
  MaxResultsSchema,
} from '../input-helpers.js';

export const SearchFilesInputSchema = z.strictObject({
  path: z
    .string()
    .min(1, 'Path cannot be empty')
    .describe('Base directory to search from'),
  pattern: z
    .string()
    .min(1, 'Pattern cannot be empty')
    .max(1000, 'Pattern is too long (max 1000 characters)')
    .refine(
      (val) => {
        try {
          if (val.includes('**/**/**')) {
            return false;
          }
          return isSafeGlobPattern(val);
        } catch {
          return false;
        }
      },
      {
        error:
          'Invalid glob pattern syntax or unsafe path (absolute/.. segments not allowed)',
      }
    )
    .describe(
      'Glob pattern to match files. Examples: "**/*.ts" (all TypeScript files), "src/**/*.js" (JS files in src), "*.json" (JSON files in current dir)'
    ),
  excludePatterns: ExcludePatternsSchema.describe('Patterns to exclude'),
  maxResults: MaxResultsSchema.describe(
    'Maximum number of matches to return (prevents huge responses)'
  ),
});

export const SearchContentInputSchema = z.strictObject({
  path: z
    .string()
    .min(1, 'Path cannot be empty')
    .describe(
      'Absolute or relative path to the base directory to search within'
    ),
  pattern: z
    .string()
    .min(1, 'Pattern cannot be empty')
    .max(1000, 'Pattern is too long (max 1000 characters)')
    .describe(
      'Regular expression pattern to search for. Examples: "TODO|FIXME" (find todos), "function\\s+\\w+" (find function declarations), "import.*from" (find imports). Use isLiteral=true for exact string matching.'
    ),
  filePattern: z
    .string()
    .min(1, 'File pattern cannot be empty')
    .max(500, 'File pattern is too long')
    .optional()
    .default('**/*')
    .refine(isSafeGlobPattern, {
      error:
        'File pattern must be relative to the base path (no absolute or ".." segments)',
    })
    .describe('Glob pattern to filter files'),
  excludePatterns: ExcludePatternsSchema.describe(
    'Glob patterns to exclude (e.g., "node_modules/**")'
  ),
  caseSensitive: CaseSensitiveSchema,
  maxResults: MaxResultsSchema.describe('Maximum number of results'),
  isLiteral: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Treat pattern as a literal string instead of regex. Special characters like ., *, ? will be escaped automatically. Use this when searching for exact text containing regex metacharacters.'
    ),
});
