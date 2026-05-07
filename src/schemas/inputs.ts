// Centralized input schemas for all 18 tools
import { z } from 'zod/v4';

import {
  DEFAULT_LIST_MAX_ENTRIES,
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_TREE_DEPTH,
  DEFAULT_TREE_ENTRIES,
  MAX_LIST_ENTRIES,
  MAX_SEARCH_DEPTH,
  MAX_SEARCH_RESULTS,
  MAX_TREE_DEPTH,
  MAX_TREE_ENTRIES,
} from '../lib/constants.js';

import { OptionalPath, RequiredPath, SafeGlobPattern } from './fields.js';
import { CursorSchema } from './pagination.js';
import {
  createReadRangeFields,
  defaultFalseBoolean,
  includeHiddenField,
  includeIgnoredField,
  validateReadRange,
} from './shared.js';

// --- List group: ls, find, tree ---

export const ListDirectoryInputSchema = z.strictObject({
  path: OptionalPath.describe('Base directory (default: root)'),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  maxDepth: z.int().min(1).max(MAX_TREE_DEPTH).optional(),
  maxEntries: z
    .int()
    .min(1)
    .max(MAX_LIST_ENTRIES)
    .optional()
    .default(DEFAULT_LIST_MAX_ENTRIES),
  sortBy: z
    .enum(['name', 'size', 'modified', 'type'])
    .optional()
    .default('name'),
  pattern: SafeGlobPattern.optional(),
  includeSymlinkTargets: defaultFalseBoolean('Resolve symlink targets'),
  cursor: CursorSchema,
});

export const SearchFilesInputSchema = z.strictObject({
  path: OptionalPath.describe('Base directory (default: root)'),
  pattern: SafeGlobPattern.describe('Glob pattern to search'),
  maxResults: z
    .int()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .default(DEFAULT_SEARCH_RESULTS),
  includeIgnored: includeIgnoredField(),
  includeHidden: includeHiddenField(),
  sortBy: z
    .enum(['name', 'size', 'modified', 'path'])
    .optional()
    .default('path'),
  maxDepth: z.int().min(0).max(MAX_SEARCH_DEPTH).optional(),
  cursor: CursorSchema,
});

export const TreeInputSchema = z.strictObject({
  path: OptionalPath.describe('Base directory (default: root)'),
  maxDepth: z
    .int()
    .min(0)
    .max(MAX_TREE_DEPTH)
    .optional()
    .default(DEFAULT_TREE_DEPTH),
  maxEntries: z
    .int()
    .min(1)
    .max(MAX_TREE_ENTRIES)
    .optional()
    .default(DEFAULT_TREE_ENTRIES),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  includeSizes: defaultFalseBoolean('Include file sizes'),
});

// --- Read group: read, read_many ---

const readRangeFields = createReadRangeFields({
  head: 'Return first N lines',
  tail: 'Return last N lines',
  startLine: 'Start line (1-indexed)',
  endLine: 'End line (1-indexed)',
});

export const ReadFileInputSchema = z
  .strictObject({
    path: OptionalPath,
    includeHash: defaultFalseBoolean('Include SHA-256 hash of the content'),
    ...readRangeFields,
  })
  .superRefine((value, ctx) => {
    validateReadRange(
      {
        head: value.head,
        tail: value.tail,
        startLine: value.startLine,
        endLine: value.endLine,
      },
      ctx
    );
  });

const readManyRangeFields = createReadRangeFields({
  head: 'Return first N lines from each',
  tail: 'Return last N lines from each',
  startLine: 'Start line (1-indexed)',
  endLine: 'End line (1-indexed)',
});

export const ReadManyInputSchema = z
  .strictObject({
    paths: z.array(RequiredPath).min(1).describe('File paths to read'),
    ...readManyRangeFields,
  })
  .superRefine((value, ctx) => {
    validateReadRange(
      {
        head: value.head,
        tail: value.tail,
        startLine: value.startLine,
        endLine: value.endLine,
      },
      ctx
    );
  });

// --- Content search: grep, search_and_replace ---

export const GrepInputSchema = z.strictObject({
  path: OptionalPath,
  pattern: SafeGlobPattern.optional().describe(
    'File glob filter (default: all text files)'
  ),
  searchPattern: z
    .string()
    .min(1)
    .max(10000)
    .describe('Text or regex to search for'),
  isRegex: defaultFalseBoolean('Treat searchPattern as regex'),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  caseSensitive: defaultFalseBoolean('Case-sensitive'),
  wholeWord: defaultFalseBoolean('Match whole words only'),
  contextLines: z
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe('Lines of context around each match'),
  maxResults: z
    .int()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .default(DEFAULT_SEARCH_RESULTS),
  maxDepth: z.int().min(0).max(MAX_SEARCH_DEPTH).optional(),
});

export const SearchAndReplaceInputSchema = z.strictObject({
  path: OptionalPath,
  pattern: SafeGlobPattern.optional().describe(
    'File glob filter (default: **/* text files)'
  ),
  searchPattern: z.string().min(1).max(10000).describe('Text or regex to find'),
  replacement: z.string().max(10000).describe('Replacement text'),
  isRegex: defaultFalseBoolean('Treat searchPattern as regex'),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  caseSensitive: defaultFalseBoolean('Case-sensitive'),
  dryRun: defaultFalseBoolean('Preview without writing'),
  returnDiff: defaultFalseBoolean('Include unified diff in output'),
  maxResults: z
    .int()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .default(DEFAULT_SEARCH_RESULTS)
    .describe('Max matches across all files'),
  maxFiles: z.int().min(1).optional().describe('Max files to process'),
  maxDepth: z.int().min(0).max(MAX_SEARCH_DEPTH).optional(),
});

// --- Stat group: stat, stat_many ---

export const StatInputSchema = z.strictObject({
  path: OptionalPath,
});

export const StatManyInputSchema = z.strictObject({
  paths: z.array(RequiredPath).min(1),
});

// --- Misc: hash, diff, patch, roots ---

export const HashInputSchema = z.strictObject({
  path: OptionalPath,
});

export const DiffFilesInputSchema = z.strictObject({
  paths: z
    .array(RequiredPath)
    .min(2)
    .max(2)
    .describe('Exactly two paths: [original, modified]'),
  context: z.int().min(0).optional().describe('Context lines (default 3)'),
  ignoreWhitespace: defaultFalseBoolean('Ignore whitespace changes'),
  stripTrailingCr: defaultFalseBoolean('Strip trailing carriage returns'),
});

export const ApplyPatchInputSchema = z.strictObject({
  path: OptionalPath,
  patch: z.string().min(1).describe('Unified diff patch content'),
  dryRun: defaultFalseBoolean('Validate patch without applying'),
  fuzzFactor: z
    .int()
    .min(0)
    .max(10)
    .optional()
    .default(0)
    .describe('Lines of context allowed to differ (0–10)'),
  autoConvertLineEndings: defaultFalseBoolean('Auto-convert line endings'),
});

export const RootsInputSchema = z.strictObject({});

// --- Write group: write, edit, mkdir, mv, rm ---

export const WriteFileInputSchema = z.strictObject({
  path: RequiredPath.describe('Target file path'),
  content: z.string(),
});

export const EditFileInputSchema = z.strictObject({
  path: OptionalPath,
  edits: z
    .array(
      z.strictObject({
        oldText: z.string().min(1, 'oldText required'),
        newText: z.string(),
      })
    )
    .min(1)
    .describe('List of text substitutions'),
  dryRun: defaultFalseBoolean('Preview changes without writing'),
  ignoreWhitespace: defaultFalseBoolean(
    'Ignore leading/trailing whitespace when matching'
  ),
});

export const CreateDirectoryInputSchema = z.strictObject({
  paths: z.array(RequiredPath).min(1),
});

export const MoveFileInputSchema = z.strictObject({
  sources: z.array(RequiredPath).min(1),
  destination: RequiredPath,
});

export const DeleteInputSchema = z.strictObject({
  path: RequiredPath,
  recursive: defaultFalseBoolean('Delete directories recursively'),
  ignoreIfNotExists: defaultFalseBoolean('No error if path does not exist'),
});
