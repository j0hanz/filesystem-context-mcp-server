import { z } from 'zod';

import {
  BaseNameMatchSchema,
  CaseSensitiveSchema,
  ContextLinesSchema,
  ExcludePatternsSchema,
  IncludeHiddenSchema,
  isSafeGlobPattern,
  MaxDepthSchema,
  MaxFileSizeSearchSchema,
  MaxFilesScannedSchema,
  MaxResultsSchema,
  SkipBinarySchema,
  SortByFileSchema,
  TimeoutMsSchema,
} from '../input-helpers.js';

export const SearchFilesInputSchema = {
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
        message:
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
  sortBy: SortByFileSchema,
  maxDepth: MaxDepthSchema.describe(
    'Maximum directory depth to search (lower values improve performance)'
  ),
  maxFilesScanned: MaxFilesScannedSchema,
  timeoutMs: TimeoutMsSchema.describe(
    'Timeout in milliseconds for the search operation'
  ),
  baseNameMatch: BaseNameMatchSchema.describe(
    'If true, patterns without slashes match against basename of paths. Useful for finding config files like "*.json" in nested directories'
  ),
  skipSymlinks: z
    .boolean()
    .optional()
    .default(true)
    .refine((value) => value, {
      message: 'Following symbolic links is not supported for security reasons',
    })
    .describe(
      'Skip symbolic links for security and performance (must remain true)'
    ),
  includeHidden: IncludeHiddenSchema.describe(
    'Include hidden files and directories (dotfiles) in the search'
  ),
};

export const SearchContentInputSchema = {
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
      message:
        'File pattern must be relative to the base path (no absolute or ".." segments)',
    })
    .describe('Glob pattern to filter files'),
  excludePatterns: ExcludePatternsSchema.describe(
    'Glob patterns to exclude (e.g., "node_modules/**")'
  ),
  caseSensitive: CaseSensitiveSchema,
  maxResults: MaxResultsSchema.describe('Maximum number of results'),
  maxFileSize: MaxFileSizeSearchSchema,
  maxFilesScanned: MaxFilesScannedSchema,
  timeoutMs: TimeoutMsSchema.describe(
    'Timeout in milliseconds for the search operation'
  ),
  skipBinary: SkipBinarySchema,
  includeHidden: IncludeHiddenSchema.describe(
    'Include hidden files and directories (dotfiles) in the search'
  ),
  contextLines: ContextLinesSchema,
  wholeWord: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Match whole words only by adding \\b word boundaries to pattern. Useful for avoiding partial matches (e.g., searching "test" won\'t match "testing")'
    ),
  isLiteral: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Treat pattern as a literal string instead of regex. Special characters like ., *, ? will be escaped automatically. Use this when searching for exact text containing regex metacharacters.'
    ),
  baseNameMatch: BaseNameMatchSchema,
  caseSensitiveFileMatch: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Case sensitive file pattern matching. Set to false for case-insensitive filename matching on case-insensitive filesystems'
    ),
};
