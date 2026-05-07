import { z } from 'zod/v4';

import {
  DEFAULT_SEARCH_RESULTS,
  MAX_SEARCH_DEPTH,
  MAX_SEARCH_RESULTS,
} from '../../lib/constants.js';
import { OptionalPath, SafeGlobPattern } from '../fields.js';
import { CursorSchema } from '../pagination.js';
import { includeHiddenField, includeIgnoredField } from '../shared.js';

export const SearchFilesInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'Base directory (default: root). Absolute path required if multiple roots.'
  ),
  pattern: SafeGlobPattern.describe(
    'Glob pattern (e.g. "**/*.ts", "src/*.js")'
  ),
  maxResults: z
    .int({ error: 'Must be integer' })
    .min(1, 'Min: 1')
    .max(MAX_SEARCH_RESULTS, `Max: ${MAX_SEARCH_RESULTS}`)
    .optional()
    .default(DEFAULT_SEARCH_RESULTS)
    .describe(
      `Max results (1-${MAX_SEARCH_RESULTS}). Default: ${DEFAULT_SEARCH_RESULTS}`
    ),
  includeIgnored: includeIgnoredField(),
  includeHidden: includeHiddenField(),
  sortBy: z
    .enum(['name', 'size', 'modified', 'path'])
    .optional()
    .default('path')
    .describe('Sort by path, name, size, or modified'),
  maxDepth: z
    .int({ error: 'Must be integer' })
    .min(0, 'Min: 0')
    .max(MAX_SEARCH_DEPTH, `Max: ${MAX_SEARCH_DEPTH}`)
    .optional()
    .describe('Maximum directory depth to scan'),
  cursor: CursorSchema,
});
