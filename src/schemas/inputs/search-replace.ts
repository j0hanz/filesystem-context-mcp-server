import { z } from 'zod/v4';

import {
  DEFAULT_SEARCH_RESULTS,
  MAX_SEARCH_DEPTH,
  MAX_SEARCH_RESULTS,
} from '../../lib/constants.js';
import { OptionalPath, SafeGlobPattern } from '../fields.js';
import { CursorSchema } from '../pagination.js';
import {
  defaultFalseBoolean,
  includeHiddenField,
  includeIgnoredField,
} from '../shared.js';

export const SearchAndReplaceInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'Base directory (default: root). Absolute path required if multiple roots.'
  ),
  pattern: SafeGlobPattern.optional().describe(
    'File glob pattern to filter (e.g. "**/*.ts")'
  ),
  searchPattern: z
    .string()
    .min(1, 'Pattern required')
    .max(10000, 'Pattern too long')
    .describe('Regex or literal text to search'),
  replacement: z
    .string()
    .max(10000, 'Replacement too long')
    .describe('Replacement text'),
  isRegex: defaultFalseBoolean(
    'Treat searchPattern as regex (default: literal text)'
  ),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  caseSensitive: defaultFalseBoolean('Case-sensitive search'),
  dryRun: defaultFalseBoolean('Preview changes without writing'),
  maxResults: z
    .int({ error: 'Must be integer' })
    .min(1, 'Min: 1')
    .max(MAX_SEARCH_RESULTS, `Max: ${MAX_SEARCH_RESULTS}`)
    .optional()
    .default(DEFAULT_SEARCH_RESULTS)
    .describe(
      `Max results (1-${MAX_SEARCH_RESULTS}). Default: ${DEFAULT_SEARCH_RESULTS}`
    ),
  maxDepth: z
    .int({ error: 'Must be integer' })
    .min(0, 'Min: 0')
    .max(MAX_SEARCH_DEPTH, `Max: ${MAX_SEARCH_DEPTH}`)
    .optional()
    .describe('Maximum directory depth to scan'),
  cursor: CursorSchema,
});
