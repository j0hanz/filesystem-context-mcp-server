import { z } from 'zod';

export const GetFileInfoInputSchema = z.strictObject({
  path: z
    .string()
    .min(1, 'Path cannot be empty')
    .describe('Path to get information about'),
});

export const GetMultipleFileInfoInputSchema = z.strictObject({
  paths: z
    .array(z.string().min(1, 'Path cannot be empty'))
    .min(1, 'At least one path is required')
    .max(100, 'Cannot get info for more than 100 files at once')
    .describe('Array of file or directory paths to get information about'),
});
