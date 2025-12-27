import { z } from 'zod';

export const FileTypeSchema = z.enum(['file', 'directory', 'symlink', 'other']);

export const ErrorSchema = z.object({
  code: z.string().describe('Error code (e.g., E_NOT_FOUND)'),
  message: z.string().describe('Human-readable error message'),
  path: z.string().optional().describe('Path that caused the error'),
  suggestion: z.string().optional().describe('Suggested action to resolve'),
});
