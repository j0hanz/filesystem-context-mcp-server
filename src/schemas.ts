import { z } from 'zod/v4';

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
import { isSafeGlobPattern } from './lib/paths.js';

const MAX_PATH_LENGTH = 4096;

const DESC_PATH_ROOT =
  'Base directory (default: root). Absolute path required if multiple roots.';

const DESC_PATH_REQUIRED = 'Absolute path to file or directory.';

function defaultFalseBoolean(
  description: string
): z.ZodDefault<z.ZodOptional<z.ZodBoolean>> {
  return z.boolean().optional().default(false).describe(description);
}

const SuccessFlagSchema = z.literal(true);
const NonNegativeIntegerSchema = z.int().min(0, 'Min: 0');
const PositiveIntegerSchema = z.int().min(1, 'Min: 1');
const IsoDateTimeSchema = z.iso.datetime();
const Sha256HexSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, 'Expected SHA-256 hex digest');

const PathSchemaBase = z
  .string()
  .max(MAX_PATH_LENGTH, `Path too long (max ${MAX_PATH_LENGTH} chars)`);

const OptionalPathSchema = PathSchemaBase.optional();

const RequiredPathSchema = PathSchemaBase.min(1, 'Path required');

const SafeGlobPatternSchema = z
  .string()
  .min(1, 'Pattern required')
  .max(1000, 'Max 1000 chars')
  .refine((val) => isSafeGlobPattern(val), {
    error: 'Invalid glob or unsafe path (absolute/.. forbidden)',
  });

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
  code: z.enum(ErrorCode).describe('Error code (e.g. NOT_FOUND)'),
  message: z.string().describe('Human-readable message'),
  path: z.string().optional().describe('Relevant path'),
  suggestion: z.string().optional().describe('Fix suggestion'),
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
  input: ReadRangeValue,
  path: keyof ReadRangeValue,
  message: string
): void {
  ctx.addIssue({
    code: 'custom',
    path: [path],
    message,
    input,
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
      value,
      'head',
      "Cannot use 'head' with 'startLine'/'endLine'"
    );
  }

  if (hasTail && (hasHead || hasStart || hasEnd)) {
    addReadRangeIssue(
      ctx,
      value,
      'tail',
      "Cannot use 'tail' with 'head'/'startLine'/'endLine'"
    );
  }

  const effectiveStart = value.startLine ?? 1;
  if (value.endLine !== undefined && value.endLine < effectiveStart) {
    addReadRangeIssue(
      ctx,
      value,
      'endLine',
      "'endLine' must be >= 'startLine'"
    );
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
  size: NonNegativeIntegerSchema.describe('Size (bytes)'),
  tokenEstimate: NonNegativeIntegerSchema.optional().describe(
    'Est. tokens (size/4)'
  ),
  created: IsoDateTimeSchema.describe('Created'),
  modified: IsoDateTimeSchema.describe('Modified'),
  accessed: IsoDateTimeSchema.describe('Accessed'),
  permissions: z.string().describe('Permissions'),
  isHidden: z.boolean().describe('Hidden?'),
  mimeType: z.string().optional().describe('MIME type'),
  symlinkTarget: z.string().optional().describe('Target (symlink)'),
});

const OperationSummarySchema = z.strictObject({
  total: NonNegativeIntegerSchema.describe('Total'),
  succeeded: NonNegativeIntegerSchema.describe('Succeeded'),
  failed: NonNegativeIntegerSchema.describe('Failed'),
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
  pattern: SafeGlobPatternSchema.optional().describe(
    'Optional glob pattern filter (e.g. "**/*.ts")'
  ),
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
  pattern: SafeGlobPatternSchema.describe(
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
  filePattern: SafeGlobPatternSchema.optional()
    .default('**/*')
    .describe('Glob for candidate files (e.g. "**/*.ts")'),
  includeHidden: defaultFalseBoolean('Include hidden items (starting with .)'),
  includeIgnored: defaultFalseBoolean(
    'Include ignored items (node_modules, etc).'
  ),
});

export const ReadFileInputSchema = z
  .strictObject({
    path: RequiredPathSchema.describe(DESC_PATH_REQUIRED),
    ...createReadRangeInputFields({
      head: 'Read first N lines (preview)',
      tail: 'Read last N lines',
      startLine:
        'Start line (1-based, inclusive). Defaults to 1 when endLine is set.',
      endLine:
        'End line (1-based, inclusive). Defaults to last line when startLine is set.',
    }),
    includeHash: defaultFalseBoolean(
      'Include SHA-256 hash of full file content'
    ),
  })
  .superRefine(validateReadRange)
  .describe(
    "Use one read mode only: 'head', 'tail', or 'startLine'/'endLine'."
  );

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
      startLine:
        'Start line (1-based, inclusive) per file. Defaults to 1 when endLine is set.',
      endLine:
        'End line (1-based, inclusive) per file. Defaults to last line when startLine is set.',
    }),
  })
  .superRefine(validateReadRange)
  .describe(
    "Use one read mode only: 'head', 'tail', or 'startLine'/'endLine'."
  );

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
  ok: SuccessFlagSchema,
  directories: z.array(z.string()).optional().describe('Allowed directories'),
});

export const ListDirectoryOutputSchema = z.strictObject({
  ok: SuccessFlagSchema,
  path: z.string().optional(),
  entries: z
    .array(
      z.strictObject({
        name: z.string().describe('Entry name'),
        relativePath: z.string().optional(),
        type: FileTypeSchema,
        size: NonNegativeIntegerSchema.optional(),
        modified: IsoDateTimeSchema.optional(),
      })
    )
    .optional(),
  totalEntries: NonNegativeIntegerSchema.optional(),
  truncated: z.boolean().optional(),
  totalFiles: NonNegativeIntegerSchema.optional(),
  totalDirectories: NonNegativeIntegerSchema.optional(),
  stoppedReason: ListDirectoryStopReasonSchema.optional(),
  skippedInaccessible: NonNegativeIntegerSchema.optional(),
  nextCursor: z
    .string()
    .optional()
    .describe('Cursor for the next page; absent on the final page'),
});

const SearchSummarySchema = z.strictObject({
  totalMatches: NonNegativeIntegerSchema.optional().describe(
    'Total matches found'
  ),
  truncated: z.boolean().optional().describe('Results truncated?'),
  resourceUri: z.string().optional().describe('Full results URI'),
});

export const SearchFilesOutputSchema = SearchSummarySchema.extend({
  ok: SuccessFlagSchema,
  root: z.string().optional().describe('Search root'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('Relative path'),
        size: NonNegativeIntegerSchema.optional(),
        modified: IsoDateTimeSchema.optional(),
      })
    )
    .optional(),
  filesScanned: NonNegativeIntegerSchema.optional().describe('Files scanned'),
  skippedInaccessible:
    NonNegativeIntegerSchema.optional().describe('Inaccessible files'),
  stoppedReason:
    SearchStopReasonSchema.optional().describe('Why search stopped'),
  nextCursor: z
    .string()
    .optional()
    .describe('Cursor for the next page; absent on the final page'),
});

export const SearchContentOutputSchema = SearchSummarySchema.extend({
  ok: SuccessFlagSchema,
  matches: z
    .array(
      z.strictObject({
        file: z.string().describe('Relative path'),
        line: PositiveIntegerSchema,
        column: NonNegativeIntegerSchema.optional().describe(
          'Column of first match (0-based)'
        ),
        content: z.string(),
        matchCount: PositiveIntegerSchema,
        contextBefore: z.array(z.string()).optional(),
        contextAfter: z.array(z.string()).optional(),
      })
    )
    .optional(),
  filesScanned: NonNegativeIntegerSchema.optional().describe('Files scanned'),
  filesMatched:
    NonNegativeIntegerSchema.optional().describe('Files with matches'),
  skippedTooLarge: NonNegativeIntegerSchema.optional().describe(
    'Files skipped: too large'
  ),
  skippedBinary: NonNegativeIntegerSchema.optional().describe(
    'Files skipped: binary'
  ),
  skippedInaccessible: NonNegativeIntegerSchema.optional().describe(
    'Files skipped: inaccessible'
  ),
  stoppedReason:
    SearchStopReasonSchema.optional().describe('Why search stopped'),
});

export const TreeOutputSchema = z.strictObject({
  ok: SuccessFlagSchema,
  root: z.string().optional(),
  tree: TreeEntrySchema.optional(),
  ascii: z.string().optional(),
  truncated: z.boolean().optional(),
  totalEntries: NonNegativeIntegerSchema.optional(),
});

const ReadResultSchema = z.strictObject({
  content: z.string().optional().describe('Content'),
  truncated: z.boolean().optional().describe('Truncated?'),
  resourceUri: z.string().optional().describe('Full content URI'),
  totalLines: NonNegativeIntegerSchema.optional().describe('Total lines'),
  head: PositiveIntegerSchema.optional().describe('Head lines'),
  tail: PositiveIntegerSchema.optional().describe('Tail lines'),
  startLine: PositiveIntegerSchema.optional().describe('Start line'),
  endLine: PositiveIntegerSchema.optional().describe('End line'),
  linesRead: NonNegativeIntegerSchema.optional().describe('Lines read'),
  hasMoreLines: z.boolean().optional().describe('More lines?'),
});

export const ReadFileOutputSchema = ReadResultSchema.extend({
  ok: SuccessFlagSchema,
  path: z.string().optional(),
  contentHash: Sha256HexSchema.optional().describe(
    'SHA-256 of full file content'
  ),
});

const ReadMultipleFileResultSchema = ReadResultSchema.extend({
  path: z.string().describe('File path'),
  truncationReason: z
    .enum(['head', 'tail', 'range', 'externalized'])
    .optional()
    .describe('Why content was truncated'),
  error: ErrorSchema.optional().describe('Structured error details'),
});

export const ReadMultipleFilesOutputSchema = z.strictObject({
  ok: SuccessFlagSchema,
  results: z.array(ReadMultipleFileResultSchema).optional(),
  summary: OperationSummarySchema.optional(),
});

export const GetFileInfoOutputSchema = z.strictObject({
  ok: SuccessFlagSchema,
  info: FileInfoSchema.optional(),
});

export const GetMultipleFileInfoOutputSchema = z.strictObject({
  ok: SuccessFlagSchema,
  results: z
    .array(
      z.strictObject({
        path: z.string(),
        info: FileInfoSchema.optional(),
        error: ErrorSchema.optional(),
      })
    )
    .optional(),
  summary: OperationSummarySchema.optional(),
});

export const CreateDirectoryInputSchema = z
  .strictObject({
    path: RequiredPathSchema.optional().describe(DESC_PATH_REQUIRED),
    paths: z
      .array(RequiredPathSchema)
      .min(1, 'Min 1 path required')
      .optional()
      .describe('Absolute paths to directories to create'),
  })
  .superRefine((data, ctx) => {
    const hasPath = data.path !== undefined;
    const hasPaths = data.paths !== undefined;

    if (!hasPath && !hasPaths) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: "Either 'path' or 'paths' must be provided",
        input: data,
      });
    }

    if (hasPath && hasPaths) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: "Provide either 'path' or 'paths', not both",
        input: data,
      });
      ctx.addIssue({
        code: 'custom',
        path: ['paths'],
        message: "Provide either 'path' or 'paths', not both",
        input: data,
      });
    }
  })
  .describe("Provide either 'path' or 'paths'.");

export const CreateDirectoryOutputSchema = z.strictObject({
  ok: SuccessFlagSchema,
  path: z.string().optional(),
  paths: z.array(z.string()).optional(),
});

export const WriteFileInputSchema = z.strictObject({
  path: RequiredPathSchema.describe(DESC_PATH_REQUIRED),
  content: z.string().describe('Content to write'),
});

export const WriteFileOutputSchema = z.strictObject({
  ok: SuccessFlagSchema,
  path: z.string().optional(),
  bytesWritten: NonNegativeIntegerSchema.optional(),
});

export const EditFileInputSchema = z.strictObject({
  path: RequiredPathSchema.describe(DESC_PATH_REQUIRED),
  edits: z
    .array(
      z.strictObject({
        oldText: z
          .string()
          .min(1, 'oldText required')
          .max(102400, 'Max 100KB')
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
  appliedEdits: NonNegativeIntegerSchema.optional(),
  linesAdded: NonNegativeIntegerSchema.optional().describe('Lines added'),
  linesRemoved: NonNegativeIntegerSchema.optional().describe('Lines removed'),
  lineRange: z
    .tuple([PositiveIntegerSchema, PositiveIntegerSchema])
    .optional()
    .describe('Line range modified [start, end] (1-based)'),
  unmatchedEdits: z
    .array(z.string())
    .optional()
    .describe('Edits that could not be applied'),
  diff: z.string().optional().describe('Unified diff of changes (dryRun)'),
});

export const MoveFileInputSchema = z
  .strictObject({
    source: RequiredPathSchema.optional().describe(
      'Path to move (deprecated: use sources)'
    ),
    sources: z
      .array(RequiredPathSchema)
      .min(1, 'Min 1 source required')
      .optional()
      .describe('Paths to move'),
    destination: RequiredPathSchema.describe('New path'),
  })
  .superRefine((data, ctx) => {
    const hasSource = data.source !== undefined;
    const hasSources = data.sources !== undefined;

    if (!hasSource && !hasSources) {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: "Either 'source' or 'sources' must be provided",
        input: data,
      });
    }

    if (hasSource && hasSources) {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: "Provide either 'source' or 'sources', not both",
        input: data,
      });
      ctx.addIssue({
        code: 'custom',
        path: ['sources'],
        message: "Provide either 'source' or 'sources', not both",
        input: data,
      });
    }
  })
  .describe("Provide either 'source' or 'sources'.");

export const MoveFileOutputSchema = z.strictObject({
  ok: z.boolean(),
  source: z.string().optional(),
  sources: z.array(z.string()).optional(),
  destination: z.string().optional(),
  failed: z
    .array(
      z.strictObject({
        source: z.string().describe('Source path'),
        error: ErrorSchema.describe('Structured error details'),
      })
    )
    .optional()
    .describe('List of files that failed to move'),
});

export const DeleteFileInputSchema = z.strictObject({
  path: RequiredPathSchema.describe(DESC_PATH_REQUIRED),
  recursive: defaultFalseBoolean('Delete non-empty directories'),
  ignoreIfNotExists: defaultFalseBoolean('No error if missing'),
});

export const DeleteFileOutputSchema = z.strictObject({
  ok: SuccessFlagSchema,
  path: z.string().optional(),
});

export const CalculateHashInputSchema = z.strictObject({
  path: RequiredPathSchema.describe(DESC_PATH_REQUIRED),
});

export const CalculateHashOutputSchema = z.strictObject({
  ok: SuccessFlagSchema,
  path: z.string().optional(),
  hash: Sha256HexSchema.optional().describe('SHA-256 hash'),
  isDirectory: z.boolean().optional().describe('True if path is a directory'),
  fileCount: NonNegativeIntegerSchema.optional().describe(
    'Number of files hashed (directories only)'
  ),
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
  ok: SuccessFlagSchema,
  diff: z.string().optional().describe('Unified diff content'),
  isIdentical: z.boolean().optional().describe('True if files are identical'),
  linesAdded: NonNegativeIntegerSchema.optional().describe('Lines added'),
  linesRemoved: NonNegativeIntegerSchema.optional().describe('Lines removed'),
  hunksCount: NonNegativeIntegerSchema.optional().describe(
    'Number of diff hunks'
  ),
  truncated: z.boolean().optional().describe('Diff content truncated?'),
  resourceUri: z.string().optional().describe('Full diff content URI'),
});

export const ApplyPatchInputSchema = z.strictObject({
  path: RequiredPathSchema.describe('Path to file to patch'),
  patch: z
    .string()
    .min(1, 'Patch content required')
    .refine((val) => /@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(val), {
      error: 'Patch must include hunk headers (e.g., @@ -1,2 +1,2 @@)',
    })
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
  hunksApplied: NonNegativeIntegerSchema.optional().describe('Hunks applied'),
  linesAdded: NonNegativeIntegerSchema.optional().describe('Lines added'),
  linesRemoved: NonNegativeIntegerSchema.optional().describe('Lines removed'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        applied: z.boolean().describe('Patch applied successfully'),
        hunksApplied:
          NonNegativeIntegerSchema.optional().describe('Hunks applied'),
        linesAdded: NonNegativeIntegerSchema.optional().describe('Lines added'),
        linesRemoved:
          NonNegativeIntegerSchema.optional().describe('Lines removed'),
        error: ErrorSchema.optional().describe('Structured error details'),
      })
    )
    .optional()
    .describe('Per-file results for multi-file patches'),
});

export const SearchAndReplaceInputSchema = z.strictObject({
  path: OptionalPathSchema.describe(DESC_PATH_ROOT),
  filePattern: SafeGlobPatternSchema.optional()
    .default('**/*')
    .describe('Glob to filter files. Default: **/*'),
  searchPattern: z
    .string()
    .min(1, 'Search pattern required')
    .max(1000, 'Max 1000 chars')
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
  includeHidden: defaultFalseBoolean(
    'Include hidden files/directories (starting with .). Default: false.'
  ),
  includeIgnored: defaultFalseBoolean(
    'Include .gitignore-ignored files (node_modules, dist). Default: false.'
  ),
  returnDiff: defaultFalseBoolean(
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
  ok: SuccessFlagSchema,
  matches: NonNegativeIntegerSchema.optional().describe('Total matches found'),
  filesChanged: NonNegativeIntegerSchema.optional().describe('Files modified'),
  processedFiles:
    NonNegativeIntegerSchema.optional().describe('Files processed'),
  failedFiles: NonNegativeIntegerSchema.optional().describe(
    'Files skipped due to errors'
  ),
  failures: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        error: ErrorSchema.describe('Structured error details'),
      })
    )
    .optional()
    .describe('Sample of per-file errors'),
  changedFiles: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        matches: PositiveIntegerSchema.describe('Matches in file'),
      })
    )
    .optional()
    .describe('Sample of changed files'),
  changedFilesTruncated: z
    .boolean()
    .optional()
    .describe('Changed file list truncated'),
  diff: z
    .string()
    .optional()
    .describe(
      'Unified diff of changes when `dryRun` or `returnDiff` is enabled'
    ),
  diffTruncated: z
    .boolean()
    .optional()
    .describe('Diff was truncated to fit size limit'),
  stoppedReason: z
    .enum(['maxFiles'])
    .optional()
    .describe('Why processing stopped early'),
});
