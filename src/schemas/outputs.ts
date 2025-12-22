import { z } from 'zod';

import { ErrorSchema, FileTypeSchema, TreeEntrySchema } from './common.js';
import { TraversalSummarySchema } from './output-helpers.js';

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

export const SearchFilesOutputSchema = z.object({
  ok: z.boolean(),
  basePath: z.string().optional(),
  pattern: z.string().optional(),
  results: z
    .array(
      z.object({
        path: z.string().describe('Relative path from basePath'),
        type: FileTypeSchema,
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

export const ReadFileOutputSchema = z.object({
  ok: z.boolean(),
  path: z.string().optional(),
  content: z.string().optional(),
  truncated: z.boolean().optional(),
  totalLines: z.number().optional(),
  error: ErrorSchema.optional(),
});

export const ReadMultipleFilesOutputSchema = z.object({
  ok: z.boolean(),
  results: z
    .array(
      z.object({
        path: z.string(),
        content: z.string().optional(),
        truncated: z.boolean().optional(),
        totalLines: z.number().optional(),
        error: z.string().optional(),
      })
    )
    .optional(),
  summary: z
    .object({
      total: z.number(),
      succeeded: z.number(),
      failed: z.number(),
    })
    .optional(),
  error: ErrorSchema.optional(),
});

export const GetFileInfoOutputSchema = z.object({
  ok: z.boolean(),
  info: z
    .object({
      name: z.string(),
      path: z.string(),
      type: FileTypeSchema,
      size: z.number(),
      created: z.string().optional(),
      modified: z.string(),
      accessed: z.string().optional(),
      permissions: z.string(),
      isHidden: z.boolean().optional(),
      mimeType: z.string().optional(),
      symlinkTarget: z.string().optional(),
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

export const AnalyzeDirectoryOutputSchema = z.object({
  ok: z.boolean(),
  path: z.string().optional(),
  totalFiles: z.number().optional(),
  totalDirectories: z.number().optional(),
  totalSize: z.number().optional(),
  fileTypes: z.record(z.number()).optional(),
  largestFiles: z
    .array(
      z.object({ path: z.string().describe('Relative path'), size: z.number() })
    )
    .optional(),
  recentlyModified: z
    .array(
      z.object({
        path: z.string().describe('Relative path'),
        modified: z.string(),
      })
    )
    .optional(),
  summary: z
    .object({
      truncated: z.boolean().optional(),
      skippedInaccessible: z.number().optional(),
      symlinksNotFollowed: z.number().optional(),
    })
    .optional(),
  error: ErrorSchema.optional(),
});

export const DirectoryTreeOutputSchema = z.object({
  ok: z.boolean(),
  tree: TreeEntrySchema.optional(),
  summary: TraversalSummarySchema.optional(),
  error: ErrorSchema.optional(),
});

export const ReadMediaFileOutputSchema = z.object({
  ok: z.boolean(),
  path: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  data: z.string().optional(),
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
