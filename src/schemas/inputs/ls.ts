import { z } from 'zod/v4';

import {
  DEFAULT_LIST_MAX_ENTRIES,
  MAX_LIST_ENTRIES,
  MAX_TREE_DEPTH,
} from '../../lib/constants.js';
import { OptionalPath, SafeGlobPattern } from '../fields.js';
import { CursorSchema } from '../pagination.js';
import {
  defaultFalseBoolean,
  includeHiddenField,
  includeIgnoredField,
} from '../shared.js';

export const ListDirectoryInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'Base directory (default: root). Absolute path required if multiple roots.'
  ),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  maxDepth: z
    .int({ error: 'Must be integer' })
    .min(1, 'Min: 1')
    .max(MAX_TREE_DEPTH, `Max: ${MAX_TREE_DEPTH}`)
    .optional()
    .describe('Max recursion depth when pattern is provided'),
  maxEntries: z
    .int({ error: 'Must be integer' })
    .min(1, 'Min: 1')
    .max(MAX_LIST_ENTRIES, `Max: ${MAX_LIST_ENTRIES}`)
    .optional()
    .default(DEFAULT_LIST_MAX_ENTRIES)
    .describe(
      `Maximum entries to return before truncation. Default: ${DEFAULT_LIST_MAX_ENTRIES}`
    ),
  sortBy: z
    .enum(['name', 'size', 'modified', 'type'])
    .optional()
    .default('name')
    .describe('Sort field (name, size, modified, type)'),
  pattern: SafeGlobPattern.optional().describe(
    'Optional glob pattern filter (e.g. "**/*.ts")'
  ),
  includeSymlinkTargets: defaultFalseBoolean(
    'Resolve and include symlink targets in results'
  ),
  cursor: CursorSchema,
});
