import { z } from 'zod';

import { ErrorSchema, FileTypeSchema } from '../common.js';
import { TraversalSummarySchema } from '../output-helpers.js';

export const ListAllowedDirectoriesOutputSchema = z.object({
  ok: z.boolean(),
  allowedDirectories: z.array(z.string()).optional(),
  count: z.number().optional().describe('Number of allowed directories'),
  accessStatus: z
    .array(
      z.object({
        path: z.string(),
        accessible: z.boolean().describe('Whether the directory exists'),
        readable: z.boolean().describe('Whether the directory is readable'),
      })
    )
    .optional()
    .describe('Access status for each allowed directory'),
  hint: z.string().optional().describe('Usage hint based on configuration'),
  error: ErrorSchema.optional(),
});

export const ListDirectoryOutputSchema = z.object({
  ok: z.boolean(),
  path: z.string().optional(),
  entries: z
    .array(
      z.object({
        name: z.string().describe('Entry name (basename)'),
        relativePath: z
          .string()
          .optional()
          .describe('Relative path from the listed base directory'),
        type: FileTypeSchema,
        extension: z
          .string()
          .optional()
          .describe('File extension without dot (e.g., "ts", "json")'),
        size: z.number().optional(),
        modified: z.string().optional(),
        symlinkTarget: z
          .string()
          .optional()
          .describe('Target path for symbolic links'),
      })
    )
    .optional(),
  summary: z
    .object({
      totalEntries: z.number().optional(),
    })
    .merge(TraversalSummarySchema)
    .optional(),
  error: ErrorSchema.optional(),
});
