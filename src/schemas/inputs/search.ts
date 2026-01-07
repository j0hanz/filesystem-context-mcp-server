import { z } from 'zod';

import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_MAX_RESULTS,
} from '../../lib/constants.js';

function isSafeGlobPattern(value: string): boolean {
  if (value.length === 0) return false;

  const absolutePattern = /^([/\\]|[A-Za-z]:[/\\]|\\\\)/u;
  if (absolutePattern.test(value)) {
    return false;
  }

  if (/[\\/]\.\.(?:[/\\]|$)/u.test(value) || value.startsWith('..')) {
    return false;
  }

  return true;
}

const ExcludePatternsSchema = z
  .array(
    z
      .string()
      .max(500, 'Individual exclude pattern is too long')
      .refine((val) => !val.includes('**/**/**'), {
        error: 'Pattern too deeply nested (max 2 levels of **)',
      })
  )
  .max(100, 'Too many exclude patterns (max 100)')
  .optional()
  .default(DEFAULT_EXCLUDE_PATTERNS);

const CaseSensitiveSchema = z
  .boolean()
  .optional()
  .default(false)
  .describe('Case sensitive search');

const MaxResultsSchema = z
  .int({ error: 'maxResults must be an integer' })
  .min(1, 'maxResults must be at least 1')
  .max(10000, 'maxResults cannot exceed 10,000')
  .optional()
  .default(DEFAULT_MAX_RESULTS)
  .describe('Maximum number of results to return');

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

const ContextLinesSchema = z
  .int({ error: 'contextLines must be an integer' })
  .min(0, 'contextLines must be at least 0')
  .max(10, 'contextLines cannot exceed 10')
  .optional()
  .default(2)
  .describe(
    'Number of lines to include before and after each match (0-10, default 2)'
  );

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
  contextLines: ContextLinesSchema,
  isLiteral: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Treat pattern as a literal string instead of regex. Special characters like ., *, ? will be escaped automatically. Use this when searching for exact text containing regex metacharacters.'
    ),
});
