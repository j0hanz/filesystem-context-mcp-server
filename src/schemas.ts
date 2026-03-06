import { z } from 'zod';

import {
  DEFAULT_LIST_MAX_ENTRIES,
  DEFAULT_SEARCH_CONTENT_RESULTS,
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_TREE_DEPTH,
  DEFAULT_TREE_ENTRIES,
  MAX_LIST_ENTRIES,
  MAX_SEARCH_DEPTH,
  MAX_SEARCH_RESULTS,
  MAX_TREE_DEPTH,
  MAX_TREE_ENTRIES,
} from './lib/constants.js';
import { ErrorCode } from './lib/errors.js';

function isSafeGlobPattern(value: string): boolean {
  if (value.length === 0) return false;
  if (value.includes('**/**/**')) return false;

  const absolutePattern = /^([/\\]|[A-Za-z]:[/\\]|\\\\)/u;
  if (absolutePattern.test(value)) {
    return false;
  }

  if (/[\\/]\.\.(?:[/\\]|$)/u.test(value) || value.startsWith('..')) {
    return false;
  }

  return true;
}

const MAX_PATH_LENGTH = 4096;

const DESC_PATH_ROOT =
  'Base directory (default: root). Absolute path required if multiple roots.';

const DESC_PATH_REQUIRED = 'Absolute path to file or directory.';

function defaultFalseBoolean(
  description: string
): z.ZodDefault<z.ZodOptional<z.ZodBoolean>> {
  return z.boolean().optional().default(false).describe(description);
}

const PathSchemaBase = z
  .string()
  .max(MAX_PATH_LENGTH, `Path too long (max ${MAX_PATH_LENGTH} chars)`);

const OptionalPathSchema = PathSchemaBase.optional();

const RequiredPathSchema = PathSchemaBase.min(1, 'Path required');

const FileTypeSchema = z.enum(['file', 'directory', 'symlink', 'other']);

const ListDirectorySortSchema = z.enum(['name', 'size', 'modified', 'type']);
const SearchFilesSortSchema = z.enum(['name', 'size', 'modified', 'path']);
const SearchStopReasonSchema = z
  .enum(['maxResults', 'maxFiles', 'timeout'])
  .describe(
    'maxResults: result limit hit; maxFiles: file count limit hit; timeout: time limit exceeded'
  );
const ListDirectoryStopReasonSchema = z
  .enum(['maxEntries', 'aborted'])
  .describe('maxEntries: entry limit hit; aborted: operation was cancelled');

interface TreeEntry {
  name: string;
  type: z.infer<typeof FileTypeSchema>;
  relativePath: string;
  size?: number | undefined;
  children?: TreeEntry[] | undefined;
}

const TreeEntrySchema: z.ZodType<TreeEntry> = z.lazy(() =>
  z.strictObject({
    name: z.string().describe('Name'),
    type: FileTypeSchema.describe('Type'),
    relativePath: z.string().describe('Relative path'),
    size: z.number().optional().describe('File size bytes (when includeSizes)'),
    children: z.array(TreeEntrySchema).optional().describe('Children'),
  })
);

const ErrorSchema = z.strictObject({
  code: z.enum(ErrorCode).describe('Error code (e.g. E_NOT_FOUND)'),
  message: z.string().describe('Human-readable message'),
  path: z.string().optional().describe('Relevant path'),
  suggestion: z.string().optional().describe('Fix suggestion'),
});

export const ToolErrorResponseSchema = z.strictObject({
  ok: z.literal(false).describe('Operation failed'),
  error: ErrorSchema.describe('Error details'),
});

const HeadLinesSchema = z
  .int({ error: 'Must be integer' })
  .min(1, 'Min: 1')
  .max(100000, 'Max: 100,000')
  .optional()
  .describe('Read first N lines');

const TailLinesSchema = z
  .int({ error: 'Must be integer' })
  .min(1, 'Min: 1')
  .max(100000, 'Max: 100,000')
  .optional()
  .describe('Read last N lines');

const LineNumberSchema = z.int({ error: 'Must be integer' }).min(1, 'Min: 1');

interface ReadRangeValue {
  head?: number | undefined;
  tail?: number | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
}

function addReadRangeIssue(
  ctx: z.RefinementCtx,
  path: keyof ReadRangeValue,
  message: string
): void {
  ctx.addIssue({
    code: 'custom',
    path: [path],
    message,
  });
}

const validateReadRange = (
  value: ReadRangeValue,
  ctx: z.RefinementCtx
): void => {
  const hasHead = value.head !== undefined;
  const hasTail = value.tail !== undefined;
  const hasStart = value.startLine !== undefined;
  const hasEnd = value.endLine !== undefined;

  if (hasHead && (hasStart || hasEnd)) {
    addReadRangeIssue(
      ctx,
      'head',
      "Cannot use 'head' with 'startLine'/'endLine'"
    );
  }

  if (hasTail && (hasHead || hasStart || hasEnd)) {
    addReadRangeIssue(
      ctx,
      'tail',
      "Cannot use 'tail' with 'head'/'startLine'/'endLine'"
    );
  }

  if (hasEnd && !hasStart) {
    addReadRangeIssue(ctx, 'endLine', "'endLine' requires 'startLine'");
  }

  if (
    value.startLine !== undefined &&
    value.endLine !== undefined &&
    value.endLine < value.startLine
  ) {
    addReadRangeIssue(ctx, 'endLine', "'endLine' must be >= 'startLine'");
  }
};

interface ReadRangeFieldDescriptions {
  head: string;
  tail: string;
  startLine: string;
  endLine: string;
}

interface ReadRangeInputFields {
  head: typeof HeadLinesSchema;
  tail: typeof TailLinesSchema;
  startLine: z.ZodOptional<typeof LineNumberSchema>;
  endLine: z.ZodOptional<typeof LineNumberSchema>;
}

function createReadRangeInputFields(
  descriptions: ReadRangeFieldDescriptions
): ReadRangeInputFields {
  return {
    head: HeadLinesSchema.describe(descriptions.head),
    tail: TailLinesSchema.describe(descriptions.tail),
    startLine: LineNumberSchema.optional().describe(descriptions.startLine),
    endLine: LineNumberSchema.optional().describe(descriptions.endLine),
  };
}

const FileInfoSchema = z.strictObject({
  name: z.string().describe('Name'),
  path: z.string().describe('Absolute path'),
  type: FileTypeSchema.describe('Type'),
  size: z.number().describe('Size (bytes)'),
  tokenEstimate: z.number().optional().describe('Est. tokens (size/4)'),
  created: z.string().describe('Created'),
  modified: z.string().describe('Modified'),
  accessed: z.string().describe('Accessed'),
  permissions: z.string().describe('Permissions'),
  isHidden: z.boolean().describe('Hidden?'),
  mimeType: z.string().optional().describe('MIME type'),
  symlinkTarget: z.string().optional().describe('Target (symlink)'),
});

const OperationSummarySchema = z.strictObject({
  total: z.number().describe('Total'),
  succeeded: z.number().describe('Succeeded'),
  failed: z.number().describe('Failed'),
});

export const ListDirectoryInputSchema = z.strictObject({
  path: OptionalPathSchema.describe(DESC_PATH_ROOT),
  includeHidden: defaultFalseBoolean('Include hidden items (starting with .)'),
  includeIgnored: defaultFalseBoolean(
    'Include ignored items (node_modules, .git, etc).'
  ),
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
  sortBy: ListDirectorySortSchema.optional()
    .default('name')
    .describe('Sort field (name, size, modified, type)'),
  pattern: z
    .string()
    .min(1, 'Pattern required')
    .max(1000, 'Max 1000 chars')
    .optional()
    .describe('Optional glob pattern filter (e.g. "**/*.ts")'),
  includeSymlinkTargets: defaultFalseBoolean(
    'Resolve and include symlink targets in results'
  ),
  cursor: z
    .string()
    .optional()
    .describe('Pagination cursor from a previous response'),
});

export const ListAllowedDirectoriesInputSchema = z
  .strictObject({})
  .describe('No input parameters.');

export const SearchFilesInputSchema = z.strictObject({
  path: OptionalPathSchema.describe(DESC_PATH_ROOT),
  pattern: z
    .string()
    .min(1, 'Pattern required')
    .max(1000, 'Max 1000 chars')
    .refine((val) => isSafeGlobPattern(val), {
      error: 'Invalid glob or unsafe path (absolute/.. forbidden)',
    })
    .describe('Glob pattern (e.g. "**/*.ts", "src/*.js")'),
  maxResults: z
    .int({ error: 'Must be integer' })
    .min(1, 'Min: 1')
    .max(MAX_SEARCH_RESULTS, `Max: ${MAX_SEARCH_RESULTS}`)
    .optional()
    .default(DEFAULT_SEARCH_RESULTS)
    .describe(
      `Max results (1-${MAX_SEARCH_RESULTS}). Default: ${DEFAULT_SEARCH_RESULTS}`
    ),
  includeIgnored: defaultFalseBoolean(
    'Include ignored items (node_modules, etc).'
  ),
  includeHidden: defaultFalseBoolean('Include hidden items (starting with .)'),
  sortBy: SearchFilesSortSchema.optional()
    .default('path')
    .describe('Sort by path, name, size, or modified'),
  maxDepth: z
    .int({ error: 'Must be integer' })
    .min(0, 'Min: 0')
    .max(MAX_SEARCH_DEPTH, `Max: ${MAX_SEARCH_DEPTH}`)
    .optional()
    .describe('Maximum directory depth to scan'),
  cursor: z
    .string()
    .optional()
    .describe('Pagination cursor from a previous response'),
});

export const TreeInputSchema = z.strictObject({
  path: OptionalPathSchema.describe(DESC_PATH_ROOT),
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
  includeHidden: defaultFalseBoolean('Include hidden items (starting with .)'),
  includeIgnored: defaultFalseBoolean(
    'Include ignored items. Disables .gitignore.'
  ),
  includeSizes: defaultFalseBoolean('Include file sizes in tree entries'),
});

export const SearchContentInputSchema = z.strictObject({
  path: OptionalPathSchema.describe(DESC_PATH_ROOT),
  pattern: z
    .string()
    .min(1, 'Pattern required')
    .max(1000, 'Max 1000 chars')
    .describe('Search text. RE2 regex when `isRegex=true`.'),
  isRegex: defaultFalseBoolean(
    'Treat pattern as RE2 regex (no lookahead/lookbehind/backrefs).'
  ),
  caseSensitive: defaultFalseBoolean(
    'Case-sensitive matching. Default: case-insensitive.'
  ),
  wholeWord: defaultFalseBoolean('Match whole words only'),
  contextLines: z
    .int({ error: 'Must be integer' })
    .min(0, 'Min: 0')
    .max(50, 'Max: 50')
    .optional()
    .default(0)
    .describe('Include N lines of context before/after matches'),
  maxResults: z
    .int({ error: 'Must be integer' })
    .min(0, 'Min: 0')
    .max(MAX_SEARCH_RESULTS, `Max: ${MAX_SEARCH_RESULTS}`)
    .optional()
    .default(DEFAULT_SEARCH_CONTENT_RESULTS)
    .describe(
      `Maximum match rows to return. Default: ${DEFAULT_SEARCH_CONTENT_RESULTS}`
    ),
  filePattern: z
    .string()
    .min(1, 'Pattern required')
    .max(1000, 'Max 1000 chars')
    .optional()
    .default('**/*')
    .describe('Glob for candidate files (e.g. "**/*.ts")'),
  includeHidden: defaultFalseBoolean('Include hidden items (starting with .)'),
  includeIgnored: defaultFalseBoolean(
    'Include ignored items (node_modules, etc).'
  ),
  multiline: defaultFalseBoolean(
    'Multi-line mode. ^ and $ match line boundaries when isRegex=true.'
  ),
});

export const ReadFileInputSchema = z
  .strictObject({
    path: RequiredPathSchema.describe(DESC_PATH_REQUIRED),
    ...createReadRangeInputFields({
      head: 'Read first N lines (preview)',
      tail: 'Read last N lines',
      startLine: 'Start line (1-based, inclusive)',
      endLine: 'End line (1-based, inclusive). Requires startLine.',
    }),
    includeHash: defaultFalseBoolean(
      'Include SHA-256 hash of full file content'
    ),
  })
  .superRefine(validateReadRange);

export const ReadMultipleFilesInputSchema = z
  .strictObject({
    paths: z
      .array(RequiredPathSchema)
      .min(1, 'Min 1 path required')
      .max(100, 'Max 100 files')
      .describe('Files to read. e.g. ["src/index.ts"]'),
    ...createReadRangeInputFields({
      head: 'Read first N lines of each file',
      tail: 'Read last N lines of each file',
      startLine: 'Start line (1-based, inclusive) per file',
      endLine: 'End line (1-based, inclusive) per file. Requires startLine.',
    }),
  })
  .superRefine(validateReadRange);

export const GetFileInfoInputSchema = z.strictObject({
  path: RequiredPathSchema.describe(DESC_PATH_REQUIRED),
});

export const GetMultipleFileInfoInputSchema = z.strictObject({
  paths: z
    .array(RequiredPathSchema)
    .min(1, 'Min 1 path required')
    .max(100, 'Max 100 files')
    .describe('File/directory paths. e.g. ["src", "lib"]'),
});

export const ListAllowedDirectoriesOutputSchema = z.strictObject({
  ok: z.boolean(),
  directories: z.array(z.string()).optional().describe('Allowed directories'),
  rootsCount: z.number().optional().describe('Number of roots'),
  hasMultipleRoots: z
    .boolean()
    .optional()
    .describe('Multiple roots configured'),
  error: ErrorSchema.optional(),
});

export const ListDirectoryOutputSchema = z.strictObject({
  ok: z.boolean(),
  path: z.string().optional(),
  entries: z
    .array(
      z.strictObject({
        name: z.string().describe('Entry name'),
        relativePath: z.string().optional(),
        type: FileTypeSchema,
        size: z.number().optional(),
        modified: z.string().optional(),
      })
    )
    .optional(),
  totalEntries: z.number().optional(),
  truncated: z.boolean().optional(),
  entriesScanned: z.number().optional(),
  entriesVisible: z.number().optional(),
  totalFiles: z.number().optional(),
  totalDirectories: z.number().optional(),
  maxDepthReached: z.number().optional(),
  stoppedReason: ListDirectoryStopReasonSchema.optional(),
  skippedInaccessible: z.number().optional(),
  symlinksNotFollowed: z.number().optional(),
  nextCursor: z
    .string()
    .optional()
    .describe('Cursor for the next page; absent on the final page'),
  error: ErrorSchema.optional(),
});

const SearchSummarySchema = z.strictObject({
  totalMatches: z.number().optional().describe('Total matches found'),
  truncated: z.boolean().optional().describe('Results truncated?'),
  resourceUri: z.string().optional().describe('Full results URI'),
  error: ErrorSchema.optional(),
});

export const SearchFilesOutputSchema = SearchSummarySchema.extend({
  ok: z.boolean(),
  root: z.string().optional().describe('Search root'),
  pattern: z.string().optional().describe('Glob pattern used'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('Relative path'),
        size: z.number().optional(),
        modified: z.string().optional(),
      })
    )
    .optional(),
  filesScanned: z.number().optional().describe('Files scanned'),
  skippedInaccessible: z.number().optional().describe('Inaccessible files'),
  stoppedReason:
    SearchStopReasonSchema.optional().describe('Why search stopped'),
  nextCursor: z
    .string()
    .optional()
    .describe('Cursor for the next page; absent on the final page'),
});

export const SearchContentOutputSchema = SearchSummarySchema.extend({
  ok: z.boolean(),
  patternType: z
    .enum(['literal', 'regex'])
    .optional()
    .describe('Pattern interpretation'),
  caseSensitive: z.boolean().optional().describe('Case-sensitive matching'),
  matches: z
    .array(
      z.strictObject({
        file: z.string().describe('Relative path'),
        line: z.number(),
        column: z
          .number()
          .optional()
          .describe('Column of first match (0-based)'),
        content: z.string(),
        matchCount: z.number(),
        contextBefore: z.array(z.string()).optional(),
        contextAfter: z.array(z.string()).optional(),
      })
    )
    .optional(),
  filesScanned: z.number().optional().describe('Files scanned'),
  filesMatched: z.number().optional().describe('Files with matches'),
  skippedTooLarge: z.number().optional().describe('Files skipped: too large'),
  skippedBinary: z.number().optional().describe('Files skipped: binary'),
  skippedInaccessible: z
    .number()
    .optional()
    .describe('Files skipped: inaccessible'),
  linesSkippedDueToRegexTimeout: z
    .number()
    .optional()
    .describe('Lines skipped due to regex timeout'),
  stoppedReason:
    SearchStopReasonSchema.optional().describe('Why search stopped'),
});

export const TreeOutputSchema = z.strictObject({
  ok: z.boolean(),
  root: z.string().optional(),
  tree: TreeEntrySchema.optional(),
  ascii: z.string().optional(),
  truncated: z.boolean().optional(),
  totalEntries: z.number().optional(),
  error: ErrorSchema.optional(),
});

const ReadResultSchema = z.strictObject({
  content: z.string().optional().describe('Content'),
  truncated: z.boolean().optional().describe('Truncated?'),
  resourceUri: z.string().optional().describe('Full content URI'),
  totalLines: z.number().optional().describe('Total lines'),
  readMode: z
    .enum(['full', 'head', 'tail', 'range'])
    .optional()
    .describe('Mode'),
  head: z.number().optional().describe('Head lines'),
  tail: z.number().optional().describe('Tail lines'),
  startLine: z.number().optional().describe('Start line'),
  endLine: z.number().optional().describe('End line'),
  linesRead: z.number().optional().describe('Lines read'),
  hasMoreLines: z.boolean().optional().describe('More lines?'),
});

export const ReadFileOutputSchema = ReadResultSchema.extend({
  ok: z.boolean(),
  path: z.string().optional(),
  contentHash: z.string().optional().describe('SHA-256 of full file content'),
  error: ErrorSchema.optional(),
});

const ReadMultipleFileResultSchema = ReadResultSchema.extend({
  path: z.string().describe('File path'),
  truncationReason: z
    .enum(['head', 'tail', 'range', 'externalized'])
    .optional()
    .describe('Why content was truncated'),
  maxTotalSize: z.number().optional().describe('Max total size budget'),
  error: z.string().optional().describe('Error message'),
});

export const ReadMultipleFilesOutputSchema = z.strictObject({
  ok: z.boolean(),
  results: z.array(ReadMultipleFileResultSchema).optional(),
  summary: OperationSummarySchema.optional(),
  error: ErrorSchema.optional(),
});

export const GetFileInfoOutputSchema = z.strictObject({
  ok: z.boolean(),
  info: FileInfoSchema.optional(),
  error: ErrorSchema.optional(),
});

export const GetMultipleFileInfoOutputSchema = z.strictObject({
  ok: z.boolean(),
  results: z
    .array(
      z.strictObject({
        path: z.string(),
        info: FileInfoSchema.optional(),
        error: z.string().optional(),
      })
    )
    .optional(),
  summary: OperationSummarySchema.optional(),
  error: ErrorSchema.optional(),
});

export const CreateDirectoryInputSchema = z
  .strictObject({
    path: RequiredPathSchema.optional().describe(DESC_PATH_REQUIRED),
    paths: z
      .array(RequiredPathSchema)
      .optional()
      .describe('Absolute paths to directories to create'),
  })
  .refine((data) => data.path !== undefined || data.paths !== undefined, {
    error: "Either 'path' or 'paths' must be provided",
    path: ['path'],
  });

export const CreateDirectoryOutputSchema = z.strictObject({
  ok: z.boolean(),
  path: z.string().optional(),
  paths: z.array(z.string()).optional(),
  error: ErrorSchema.optional(),
});

export const WriteFileInputSchema = z.strictObject({
  path: RequiredPathSchema.describe(DESC_PATH_REQUIRED),
  content: z.string().describe('Content to write'),
});

export const WriteFileOutputSchema = z.strictObject({
  ok: z.boolean(),
  path: z.string().optional(),
  bytesWritten: z.number().optional(),
  error: ErrorSchema.optional(),
});

export const EditFileInputSchema = z.strictObject({
  path: RequiredPathSchema.describe(DESC_PATH_REQUIRED),
  edits: z
    .array(
      z.strictObject({
        oldText: z
          .string()
          .describe(
            'Exact literal string to replace (character-for-character). Include 3–5 lines of context for unique targeting.'
          ),
        newText: z
          .string()
          .describe(
            'Replacement string. Preserve surrounding indentation style.'
          ),
      })
    )
    .min(1, 'Min 1 edit required')
    .describe(
      'List of replacements to apply sequentially. Each edit replaces the first occurrence of oldText.'
    ),
  dryRun: defaultFalseBoolean(
    'Preview edits without writing. Check `unmatchedEdits` in response.'
  ),
  ignoreWhitespace: defaultFalseBoolean(
    'Treat all whitespace sequences as equivalent when matching oldText.'
  ),
});

export const EditFileOutputSchema = z.strictObject({
  ok: z.boolean(),
  path: z.string().optional(),
  appliedEdits: z.number().optional(),
  lineRange: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe('Line range modified [start, end] (1-based)'),
  unmatchedEdits: z
    .array(z.string())
    .optional()
    .describe('Edits that could not be applied'),
  diff: z.string().optional().describe('Unified diff of changes (dryRun)'),
  error: ErrorSchema.optional(),
});

export const MoveFileInputSchema = z
  .strictObject({
    source: RequiredPathSchema.optional().describe(
      'Path to move (deprecated: use sources)'
    ),
    sources: z.array(RequiredPathSchema).optional().describe('Paths to move'),
    destination: RequiredPathSchema.describe('New path'),
  })
  .refine((data) => (data.source ?? data.sources) !== undefined, {
    error: "Either 'source' or 'sources' must be provided",
    path: ['source'],
  });

export const MoveFileOutputSchema = z.strictObject({
  ok: z.boolean(),
  source: z.string().optional(),
  sources: z.array(z.string()).optional(),
  destination: z.string().optional(),
  failed: z
    .array(
      z.strictObject({
        source: z.string().describe('Source path'),
        error: z.string().describe('Error message'),
      })
    )
    .optional()
    .describe('List of files that failed to move'),
  error: ErrorSchema.optional(),
});

export const DeleteFileInputSchema = z.strictObject({
  path: RequiredPathSchema.describe(DESC_PATH_REQUIRED),
  recursive: defaultFalseBoolean('Delete non-empty directories'),
  ignoreIfNotExists: defaultFalseBoolean('No error if missing'),
});

export const DeleteFileOutputSchema = z.strictObject({
  ok: z.boolean(),
  path: z.string().optional(),
  error: ErrorSchema.optional(),
});

export const CalculateHashInputSchema = z.strictObject({
  path: RequiredPathSchema.describe(DESC_PATH_REQUIRED),
});

export const CalculateHashOutputSchema = z.strictObject({
  ok: z.boolean(),
  path: z.string().optional(),
  hash: z.string().optional().describe('SHA-256 hash'),
  isDirectory: z.boolean().optional().describe('True if path is a directory'),
  fileCount: z
    .number()
    .optional()
    .describe('Number of files hashed (directories only)'),
  error: ErrorSchema.optional(),
});

export const DiffFilesInputSchema = z.strictObject({
  original: RequiredPathSchema.describe('Path to original file'),
  modified: RequiredPathSchema.describe('Path to modified file'),
  context: z
    .int({ error: 'Must be integer' })
    .min(0, 'Min: 0')
    .max(10000, 'Max: 10,000')
    .optional()
    .describe('Lines of context to include in the diff'),
  ignoreWhitespace: z
    .boolean()
    .optional()
    .default(false)
    .describe('Ignore leading/trailing whitespace when comparing lines'),
  stripTrailingCr: z
    .boolean()
    .optional()
    .default(false)
    .describe('Strip trailing carriage returns before diffing'),
});

export const DiffFilesOutputSchema = z.strictObject({
  ok: z.boolean(),
  diff: z.string().optional().describe('Unified diff content'),
  isIdentical: z.boolean().optional().describe('True if files are identical'),
  linesAdded: z.number().optional().describe('Lines added'),
  linesRemoved: z.number().optional().describe('Lines removed'),
  hunksCount: z.number().optional().describe('Number of diff hunks'),
  truncated: z.boolean().optional().describe('Diff content truncated?'),
  resourceUri: z.string().optional().describe('Full diff content URI'),
  error: ErrorSchema.optional(),
});

export const ApplyPatchInputSchema = z.strictObject({
  path: RequiredPathSchema.describe('Path to file to patch'),
  patch: z
    .string()
    .describe('Unified diff with @@ hunk headers. Generate with `diff_files`.'),
  fuzzFactor: z
    .int({ error: 'Must be integer' })
    .min(0, 'Min: 0')
    .max(20, 'Max: 20')
    .optional()
    .describe('Maximum fuzzy mismatches per hunk'),
  autoConvertLineEndings: z
    .boolean()
    .optional()
    .default(true)
    .describe('Auto-convert line endings to match target file'),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Validate patch without writing. Check `applied` before committing.'
    ),
});

export const ApplyPatchOutputSchema = z.strictObject({
  ok: z.boolean(),
  path: z.string().optional(),
  applied: z.boolean().optional(),
  hunksApplied: z.number().optional().describe('Hunks applied'),
  linesAdded: z.number().optional().describe('Lines added'),
  linesRemoved: z.number().optional().describe('Lines removed'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        applied: z.boolean().describe('Patch applied successfully'),
        hunksApplied: z.number().optional().describe('Hunks applied'),
        linesAdded: z.number().optional().describe('Lines added'),
        linesRemoved: z.number().optional().describe('Lines removed'),
        error: z.string().optional().describe('Error message'),
      })
    )
    .optional()
    .describe('Per-file results for multi-file patches'),
  error: ErrorSchema.optional(),
});

export const SearchAndReplaceInputSchema = z.strictObject({
  path: OptionalPathSchema.describe(DESC_PATH_ROOT),
  filePattern: z
    .string()
    .min(1, 'Pattern required')
    .max(1000, 'Max 1000 chars')
    .optional()
    .default('**/*')
    .refine((val) => isSafeGlobPattern(val), {
      error: 'Invalid glob or unsafe path (absolute/.. forbidden)',
    })
    .describe('Glob to filter files. Default: **/*'),
  searchPattern: z
    .string()
    .min(1, 'Search pattern required')
    .describe(
      'Text to search for. Literal by default; RE2 regex when `isRegex=true`.'
    ),
  replacement: z.string().describe('Replacement text'),
  isRegex: defaultFalseBoolean(
    'Treat searchPattern as RE2 regex. Supports capture groups ($1, $2) in replacement.'
  ),
  caseSensitive: z
    .boolean()
    .optional()
    .default(true)
    .describe('Case-sensitive matching. Default: true.'),
  dryRun: defaultFalseBoolean(
    'Preview matches without writing. Check changedFiles and matches in the response before committing.'
  ),
  includeHidden: z
    .boolean()
    .optional()
    .describe(
      'Include hidden files/directories (starting with .). Default: false.'
    ),
  includeIgnored: z
    .boolean()
    .optional()
    .describe(
      'Include .gitignore-ignored files (node_modules, dist). Default: false.'
    ),
  returnDiff: z
    .boolean()
    .optional()
    .describe(
      'Return unified diff of changes even if dryRun is false. Default: false.'
    ),
  maxFiles: z
    .int({ error: 'Must be integer' })
    .min(1, 'Min: 1')
    .max(10000, 'Max: 10,000')
    .optional()
    .describe('Max files to process before stopping'),
});

export const SearchAndReplaceOutputSchema = z.strictObject({
  ok: z.boolean(),
  matches: z.number().optional().describe('Total matches found'),
  filesChanged: z.number().optional().describe('Files modified'),
  processedFiles: z.number().optional().describe('Files processed'),
  failedFiles: z.number().optional().describe('Files skipped due to errors'),
  failures: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        error: z.string().describe('Error message'),
      })
    )
    .optional()
    .describe('Sample of per-file errors'),
  changedFiles: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        matches: z.number().describe('Matches in file'),
      })
    )
    .optional()
    .describe('Sample of changed files'),
  changedFilesTruncated: z
    .boolean()
    .optional()
    .describe('Changed file list truncated'),
  diff: z.string().optional().describe('Unified diff of changes (dryRun only)'),
  diffTruncated: z
    .boolean()
    .optional()
    .describe('Diff was truncated to fit size limit'),
  stoppedReason: z
    .enum(['maxFiles'])
    .optional()
    .describe('Why processing stopped early'),
  dryRun: z.boolean().optional(),
  error: ErrorSchema.optional(),
});
