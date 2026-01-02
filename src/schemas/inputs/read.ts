import { z } from 'zod';

import {
  applyLineRangeIssues,
  EncodingSchema,
  HeadLinesSchema,
  LineEndSchema,
  LineStartSchema,
  ReadFileMaxSizeSchema,
  ReadMultipleFilesMaxSizeSchema,
  SkipBinarySchema,
  TailLinesSchema,
} from '../input-helpers.js';

const ReadFileBaseSchema = z.strictObject({
  path: z
    .string()
    .min(1, 'Path cannot be empty')
    .describe('Path to the file to read'),
  encoding: EncodingSchema,
  maxSize: ReadFileMaxSizeSchema,
  lineStart: LineStartSchema,
  lineEnd: LineEndSchema,
  skipBinary: SkipBinarySchema,
  head: HeadLinesSchema.describe(
    'Read only the first N lines of the file (memory efficient for large files)'
  ),
  tail: TailLinesSchema.describe(
    'Read only the last N lines of the file (memory efficient for large files)'
  ),
});

export const ReadFileInputSchema = ReadFileBaseSchema.superRefine(
  (data, ctx) => {
    applyLineRangeIssues(
      {
        lineStart: data.lineStart,
        lineEnd: data.lineEnd,
        head: data.head,
        tail: data.tail,
      },
      ctx
    );
  }
);

const ReadMultipleFilesBaseSchema = z.strictObject({
  paths: z
    .array(z.string().min(1, 'Path cannot be empty'))
    .min(1, 'At least one path is required')
    .max(100, 'Cannot read more than 100 files at once')
    .describe('Array of file paths to read'),
  encoding: EncodingSchema,
  maxSize: ReadMultipleFilesMaxSizeSchema,
  maxTotalSize: z
    .int({ error: 'maxTotalSize must be an integer' })
    .min(1, 'maxTotalSize must be at least 1 byte')
    .max(1024 * 1024 * 1024, 'maxTotalSize cannot exceed 1GB')
    .optional()
    .default(100 * 1024 * 1024)
    .describe(
      'Maximum total size in bytes for all files combined (default 100MB)'
    ),
  head: HeadLinesSchema.describe('Read only the first N lines of each file'),
  tail: TailLinesSchema.describe('Read only the last N lines of each file'),
  lineStart: LineStartSchema.describe(
    'Start line (1-indexed) for reading a range from each file'
  ),
  lineEnd: LineEndSchema.describe(
    'End line (inclusive) for reading a range from each file'
  ),
});

export const ReadMultipleFilesInputSchema =
  ReadMultipleFilesBaseSchema.superRefine((data, ctx) => {
    applyLineRangeIssues(
      {
        lineStart: data.lineStart,
        lineEnd: data.lineEnd,
        head: data.head,
        tail: data.tail,
      },
      ctx
    );
  });
