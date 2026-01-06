import { z } from 'zod';

import { ErrorSchema } from '../error-schema.js';

const SearchFilesTypeSchema = z.enum(['file', 'symlink', 'other']);

export const SearchFilesOutputSchema = z.object({
  ok: z.boolean(),
  basePath: z.string().optional(),
  pattern: z.string().optional(),
  effectiveOptions: z
    .object({
      excludePatterns: z.array(z.string()),
      maxResults: z.number(),
      sortBy: z.enum(['name', 'size', 'modified', 'path']),
      maxDepth: z.number(),
      maxFilesScanned: z.number(),
      timeoutMs: z.number(),
      baseNameMatch: z.boolean(),
      skipSymlinks: z.boolean(),
      includeHidden: z.boolean(),
    })
    .optional()
    .describe('Effective options used for the search'),
  results: z
    .array(
      z.object({
        path: z.string().describe('Relative path from basePath'),
        type: SearchFilesTypeSchema,
        size: z.number().optional(),
        modified: z.string().optional(),
      })
    )
    .optional(),
  summary: z
    .object({
      matched: z.number(),
      truncated: z.boolean(),
      skippedInaccessible: z.number().optional(),
      filesScanned: z
        .number()
        .optional()
        .describe('Total number of files scanned by the glob pattern'),
      stoppedReason: z.enum(['maxResults', 'maxFiles', 'timeout']).optional(),
    })
    .optional(),
  error: ErrorSchema.optional(),
});

export const SearchContentOutputSchema = z.object({
  ok: z.boolean(),
  basePath: z.string().optional(),
  pattern: z.string().optional(),
  filePattern: z.string().optional(),
  effectiveOptions: z
    .object({
      filePattern: z.string(),
      excludePatterns: z.array(z.string()),
      caseSensitive: z.boolean(),
      maxResults: z.number(),
      maxFileSize: z.number(),
      maxFilesScanned: z.number(),
      timeoutMs: z.number(),
      skipBinary: z.boolean(),
      includeHidden: z.boolean(),
      contextLines: z.number(),
      wholeWord: z.boolean(),
      isLiteral: z.boolean(),
      baseNameMatch: z.boolean(),
      caseSensitiveFileMatch: z.boolean(),
    })
    .optional()
    .describe('Effective options used for the content search'),
  matches: z
    .array(
      z.object({
        file: z.string().describe('Relative path from basePath'),
        line: z.number(),
        content: z.string(),
        contextBefore: z.array(z.string()).optional(),
        contextAfter: z.array(z.string()).optional(),
        matchCount: z.number().optional(),
      })
    )
    .optional(),
  summary: z
    .object({
      filesScanned: z.number().optional(),
      filesMatched: z.number(),
      totalMatches: z.number(),
      truncated: z.boolean(),
      skippedTooLarge: z.number().optional(),
      skippedBinary: z.number().optional(),
      skippedInaccessible: z.number().optional(),
      linesSkippedDueToRegexTimeout: z
        .number()
        .optional()
        .describe(
          'Number of lines skipped due to regex matching time budget. Currently always 0 (no per-line timeout is enforced); reserved for future implementations.'
        ),
      stoppedReason: z.enum(['maxResults', 'maxFiles', 'timeout']).optional(),
    })
    .optional(),
  error: ErrorSchema.optional(),
});
