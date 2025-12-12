import { z } from 'zod';

export const FileTypeSchema = z.enum(['file', 'directory', 'symlink', 'other']);

export const ErrorSchema = z.object({
  code: z.string().describe('Error code (e.g., E_NOT_FOUND)'),
  message: z.string().describe('Human-readable error message'),
  path: z.string().optional().describe('Path that caused the error'),
  suggestion: z.string().optional().describe('Suggested action to resolve'),
});

const BaseTreeEntrySchema = z.object({
  name: z.string().describe('File or directory name'),
  type: z.enum(['file', 'directory']).describe('Entry type'),
  size: z.number().optional().describe('File size in bytes (files only)'),
});

type TreeEntryType = z.infer<typeof BaseTreeEntrySchema> & {
  children?: TreeEntryType[];
};

export const TreeEntrySchema: z.ZodType<TreeEntryType> =
  BaseTreeEntrySchema.extend({
    children: z
      .lazy(() => z.array(TreeEntrySchema).optional())
      .describe('Nested children (directories only)'),
  });
