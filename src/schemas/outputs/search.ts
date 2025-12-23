import { z } from 'zod';

import { ErrorSchema } from '../common.js';

const SearchFilesTypeSchema = z.enum(['file', 'symlink', 'other']);

export const SearchFilesOutputSchema = z.object({
  ok: z.boolean(),
  basePath: z.string().optional(),
  pattern: z.string().optional(),
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
          'Number of lines skipped due to regex matching timeout (potential incomplete results)'
        ),
      stoppedReason: z.enum(['maxResults', 'maxFiles', 'timeout']).optional(),
    })
    .optional(),
  error: ErrorSchema.optional(),
});

export const DefinitionTypeOutputSchema = z.enum([
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'variable',
]);

export const SearchDefinitionsOutputSchema = z.object({
  ok: z.boolean(),
  basePath: z.string().optional(),
  searchName: z.string().optional(),
  searchType: DefinitionTypeOutputSchema.optional(),
  definitions: z
    .array(
      z.object({
        file: z.string().describe('Relative path from basePath'),
        line: z.number(),
        definitionType: DefinitionTypeOutputSchema,
        name: z.string().describe('Extracted definition name'),
        content: z.string().describe('The line containing the definition'),
        contextBefore: z.array(z.string()).optional(),
        contextAfter: z.array(z.string()).optional(),
        exported: z.boolean().describe('Whether the definition is exported'),
      })
    )
    .optional(),
  summary: z
    .object({
      filesScanned: z.number(),
      filesMatched: z.number(),
      totalDefinitions: z.number(),
      truncated: z.boolean(),
    })
    .optional(),
  error: ErrorSchema.optional(),
});
