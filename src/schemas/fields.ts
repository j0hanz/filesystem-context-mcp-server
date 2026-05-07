// src/schemas/fields.ts
import { z } from 'zod/v4';

import { ErrorCode } from '../lib/errors.js';
import { isSafeGlobPattern } from '../lib/paths.js';

function reg<T extends z.ZodType>(
  schema: T,
  id: string,
  extra?: Record<string, unknown>
): T {
  z.globalRegistry.add(schema, { id, ...extra });
  return schema;
}

// Runtime: full ISO-8601 UTC validation. Wire: format only (pattern stripped by post-processor).
export const IsoDateTime = reg(
  z.iso.datetime().describe('ISO 8601 date-time (UTC)'),
  'IsoDateTime'
);

export const Sha256Hex = reg(
  z
    .string()
    .regex(/^[a-f0-9]{64}$/u, 'Expected SHA-256 hex digest')
    .describe('SHA-256 hex digest'),
  'Sha256Hex'
);

export const NonNegInt = reg(
  z.int({ error: 'Must be integer' }).min(0, 'Min: 0'),
  'NonNegInt'
);

export const PositiveInt = reg(
  z.int({ error: 'Must be integer' }).min(1, 'Min: 1'),
  'PositiveInt'
);

export const FileType = reg(
  z.enum(['file', 'directory', 'symlink', 'other']),
  'FileType'
);

// Unified across ls/find/grep/search_and_replace — replaces three separate enums.
export const StoppedReason = reg(
  z
    .enum(['maxResults', 'maxFiles', 'maxEntries', 'timeout', 'aborted'])
    .describe(
      'maxResults: result limit hit; maxFiles: file count hit; maxEntries: entry limit hit; timeout: time limit exceeded; aborted: operation cancelled'
    ),
  'StoppedReason'
);

export const ErrorCodeEnum = reg(
  z.enum(ErrorCode).describe('Error code'),
  'ErrorCodeEnum'
);

export const MAX_PATH_LENGTH = 4096;

const PathBase = z
  .string()
  .max(MAX_PATH_LENGTH, `Path too long (max ${MAX_PATH_LENGTH} chars)`);
// OptionalPath and RequiredPath are not registered (used once per schema, $ref not worth it).
export const OptionalPath = PathBase.optional();
export const RequiredPath = PathBase.min(1, 'Path required');

// SafeGlobPattern: includes runtime safety check + examples for discoverability.
// Usage sites do NOT need to add .refine() again — it's baked in here.
export const SafeGlobPattern = reg(
  z
    .string()
    .min(1, 'Pattern required')
    .max(1000, 'Max 1000 chars')
    .refine((val) => isSafeGlobPattern(val), {
      error: 'Invalid glob or unsafe path (absolute/.. forbidden)',
    })
    .describe('Glob pattern (e.g. "**/*.ts", "src/**/*.js")'),
  'SafeGlobPattern',
  { examples: ['**/*.ts', 'src/**/*.js', '*.{ts,tsx}'] }
);
