import { z } from 'zod';

import { MAX_TEXT_FILE_SIZE } from '../lib/constants.js';

export function isSafeGlobPattern(value: string): boolean {
  if (value.length === 0) return false;

  const absolutePattern = /^([/\\]|[A-Za-z]:[/\\]|\\\\)/u;
  if (absolutePattern.test(value)) {
    return false;
  }

  if (/[\\/]\.\.(?:[/\\]|$)/u.test(value) || value.startsWith('..')) {
    return false;
  }

  return true;
}

export const EncodingSchema = z
  .enum(['utf-8', 'utf8', 'ascii', 'base64', 'hex', 'latin1'])
  .optional()
  .default('utf-8')
  .describe('File encoding');

const MaxTextFileSizeSchema = z
  .number()
  .int('maxSize must be an integer')
  .min(1, 'maxSize must be at least 1 byte')
  .max(100 * 1024 * 1024, 'maxSize cannot exceed 100MB')
  .optional()
  .default(MAX_TEXT_FILE_SIZE);

export const ReadFileMaxSizeSchema = MaxTextFileSizeSchema.describe(
  'Maximum file size in bytes (default 10MB)'
);

export const ReadMultipleFilesMaxSizeSchema = MaxTextFileSizeSchema.describe(
  'Maximum file size in bytes per file (default 10MB)'
);

export const ExcludePatternsSchema = z
  .array(
    z
      .string()
      .max(500, 'Individual exclude pattern is too long')
      .refine((val) => !val.includes('**/**/**'), {
        message: 'Pattern too deeply nested (max 2 levels of **)',
      })
  )
  .max(100, 'Too many exclude patterns (max 100)')
  .optional()
  .default([]);

export const BasicExcludePatternsSchema = z
  .array(z.string().max(500, 'Individual exclude pattern is too long'))
  .max(100, 'Too many exclude patterns (max 100)')
  .optional()
  .default([]);
