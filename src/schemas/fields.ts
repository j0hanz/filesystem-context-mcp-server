// src/schemas/fields.ts
import { z } from 'zod/v4';

import { isSafeGlobSyntax } from '../lib/paths.js';

// Runtime: full ISO-8601 UTC validation. Wire: format only (pattern stripped by post-processor).
export const IsoDateTime = z.iso
  .datetime()
  .describe('ISO 8601 date-time (UTC)')
  .meta({ id: 'IsoDateTime' });

export const Sha256Hex = z
  .hash('sha256')
  .describe('SHA-256 hex digest')
  .meta({ id: 'Sha256Hex' });

export const NonNegInt = z
  .int({ error: 'Must be integer' })
  .min(0, 'Min: 0')
  .meta({ id: 'NonNegInt' });

export const PositiveInt = z
  .int({ error: 'Must be integer' })
  .min(1, 'Min: 1')
  .meta({ id: 'PositiveInt' });

export const FileType = z
  .enum(['file', 'directory', 'symlink', 'other'])
  .meta({ id: 'FileType' });

const MAX_PATH_LENGTH = 4096;

const PathBase = z
  .string()
  .min(1, 'Path required')
  .max(MAX_PATH_LENGTH, `Path too long (max ${MAX_PATH_LENGTH} chars)`)
  .describe('Path inside an allowed root');
// OptionalPath and RequiredPath are not registered (used once per schema, $ref not worth it).
export const OptionalPath = PathBase.optional();
export const RequiredPath = PathBase;

// SafeGlobPattern: includes runtime safety check + examples for discoverability.
// Usage sites do NOT need to add .refine() again — it's baked in here.
export const SafeGlobPattern = z
  .string()
  .min(1, 'Pattern required')
  .max(1000, 'Max 1000 chars')
  .refine((val) => isSafeGlobSyntax(val), {
    error: 'Invalid glob or unsafe path (absolute/.. forbidden)',
  })
  .describe('Glob pattern (e.g. "**/*.ts", "src/**/*.js")')
  .meta({
    id: 'SafeGlobPattern',
    examples: ['**/*.ts', 'src/**/*.js', '*.{ts,tsx}'],
  });
