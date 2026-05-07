import { z } from 'zod/v4';

import {
  DEFAULT_TREE_DEPTH,
  DEFAULT_TREE_ENTRIES,
  MAX_TREE_DEPTH,
  MAX_TREE_ENTRIES,
} from '../../lib/constants.js';
import { OptionalPath } from '../fields.js';
import {
  defaultFalseBoolean,
  includeHiddenField,
  includeIgnoredField,
} from '../shared.js';

export const TreeInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'Base directory (default: root). Absolute path required if multiple roots.'
  ),
  maxDepth: z
    .int({ error: 'Must be integer' })
    .min(0, 'Min: 0')
    .max(MAX_TREE_DEPTH, `Max: ${MAX_TREE_DEPTH}`)
    .optional()
    .default(DEFAULT_TREE_DEPTH)
    .describe(
      `Depth (0=root node only, no children). Default: ${DEFAULT_TREE_DEPTH}`
    ),
  maxEntries: z
    .int({ error: 'Must be integer' })
    .min(1, 'Min: 1')
    .max(MAX_TREE_ENTRIES, `Max: ${MAX_TREE_ENTRIES}`)
    .optional()
    .default(DEFAULT_TREE_ENTRIES)
    .describe(`Max entries. Default: ${DEFAULT_TREE_ENTRIES}`),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  includeSizes: defaultFalseBoolean('Include file sizes in tree entries'),
});
