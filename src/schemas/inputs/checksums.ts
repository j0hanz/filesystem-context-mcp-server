import { z } from 'zod';

const ChecksumAlgorithmSchema = z.enum(['md5', 'sha1', 'sha256', 'sha512']);
const ChecksumEncodingSchema = z.enum(['hex', 'base64']);

export const ComputeChecksumsInputSchema = {
  paths: z
    .array(z.string().min(1, 'Path cannot be empty'))
    .min(1, 'At least one path is required')
    .max(50, 'Cannot compute checksums for more than 50 files at once')
    .describe('Array of file paths to compute checksums for'),
  algorithm: ChecksumAlgorithmSchema.optional()
    .default('sha256')
    .describe(
      'Hash algorithm to use: md5, sha1, sha256, sha512 (default: sha256)'
    ),
  encoding: ChecksumEncodingSchema.optional()
    .default('hex')
    .describe('Output encoding: hex or base64 (default: hex)'),
  maxFileSize: z
    .number()
    .int('maxFileSize must be an integer')
    .min(1, 'maxFileSize must be at least 1 byte')
    .max(1024 * 1024 * 1024, 'maxFileSize cannot exceed 1GB')
    .optional()
    .default(100 * 1024 * 1024)
    .describe(
      'Maximum file size to process in bytes (default: 100MB). Files larger than this will be skipped.'
    ),
};
