import { z } from 'zod';

import { isSafeGlobPattern } from './helpers.js';

export const SearchFilesInputSchema = z.strictObject({
  path: z
    .string()
    .optional()
    .describe(
      'Base directory to search from (leave empty for workspace root). ' +
        'Examples: "src", "lib", "tests"'
    ),
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
  maxResults: z
    .number()
    .int({ error: 'maxResults must be an integer' })
    .min(1, 'maxResults must be at least 1')
    .max(10000, 'maxResults cannot exceed 10,000')
    .optional()
    .default(100)
    .describe('Maximum matches to return (1-10000)'),
});

export const SearchContentInputSchema = z.strictObject({
  path: z
    .string()
    .optional()
    .describe(
      'Base directory to search within (leave empty for workspace root). ' +
        'Examples: "src", "lib", "tests"'
    ),
  pattern: z
    .string()
    .min(1, 'Pattern cannot be empty')
    .max(1000, 'Pattern is too long (max 1000 characters)')
    .describe(
      'Text to search for. Examples: "console.log", "import React", "className"'
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
    .describe(
      'Glob pattern to filter files. Examples: "**/*.ts", "src/**/*.js"'
    ),
  excludePatterns: z
    .array(
      z
        .string()
        .min(1, 'Exclude pattern cannot be empty')
        .max(500, 'Exclude pattern is too long')
        .refine(isSafeGlobPattern, {
          error:
            'Exclude pattern must be relative to the base path (no absolute or ".." segments)',
        })
    )
    .max(100, 'Too many exclude patterns (max 100)')
    .optional()
    .describe('Glob patterns to exclude'),
  caseSensitive: z
    .boolean()
    .optional()
    .default(false)
    .describe('Case-sensitive search'),
  maxResults: z
    .number()
    .int({ error: 'maxResults must be an integer' })
    .min(1, 'maxResults must be at least 1')
    .max(10000, 'maxResults cannot exceed 10,000')
    .optional()
    .default(100)
    .describe('Maximum number of results'),
  maxFileSize: z
    .number()
    .int({ error: 'maxFileSize must be an integer' })
    .min(1024, 'maxFileSize must be at least 1024 bytes')
    .max(10 * 1024 * 1024, 'maxFileSize cannot exceed 10MB')
    .optional()
    .describe('Maximum file size to scan'),
  maxFilesScanned: z
    .number()
    .int({ error: 'maxFilesScanned must be an integer' })
    .min(1, 'maxFilesScanned must be at least 1')
    .max(200000, 'maxFilesScanned cannot exceed 200,000')
    .optional()
    .default(20000)
    .describe('Maximum files to scan before stopping'),
  timeoutMs: z
    .number()
    .int({ error: 'timeoutMs must be an integer' })
    .min(100, 'timeoutMs must be at least 100ms')
    .max(3600000, 'timeoutMs cannot exceed 1 hour')
    .optional()
    .default(30000)
    .describe('Timeout in milliseconds'),
  skipBinary: z
    .boolean()
    .optional()
    .default(true)
    .describe('Skip likely-binary files'),
  includeHidden: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include hidden files and directories'),
  contextLines: z
    .number()
    .int({ error: 'contextLines must be an integer' })
    .min(0, 'contextLines must be at least 0')
    .max(10, 'contextLines cannot exceed 10')
    .optional()
    .default(0)
    .describe('Lines of context before/after match (0-10)'),
  wholeWord: z
    .boolean()
    .optional()
    .default(false)
    .describe('Match whole words only'),
  isLiteral: z
    .boolean()
    .optional()
    .default(false)
    .describe('Treat pattern as literal string (escape regex chars)'),
  baseNameMatch: z
    .boolean()
    .optional()
    .default(false)
    .describe('Match file patterns without slashes against basenames'),
  caseSensitiveFileMatch: z
    .boolean()
    .optional()
    .default(true)
    .describe('Case-sensitive filename matching'),
  includeIgnored: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Include normally ignored directories (node_modules, dist, .git, etc). ' +
        'Set to true when debugging in dependencies.'
    ),
});
