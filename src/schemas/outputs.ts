// Centralized output schemas for all 18 tools
import { z } from 'zod/v4';

import {
  FileType as FileTypeEnum,
  NonNegInt,
  PositiveInt,
  Sha256Hex,
} from './fields.js';
import { NextCursorSchema } from './pagination.js';
import {
  FileInfoSchema,
  OperationSummarySchema,
  PerFileErrorSchema,
} from './shared.js';

// --- List group: ls, find, tree ---

export const ListDirectoryOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  path: z.string().optional().describe('Listed directory path'),
  entries: z
    .array(
      z.strictObject({
        name: z.string().describe('Entry name'),
        relativePath: z
          .string()
          .describe('Relative path from listed directory'),
        type: FileTypeEnum.describe('Entry type'),
        size: NonNegInt.optional().describe('Size in bytes'),
        modified: z.string().optional().describe('ISO 8601 last modified time'),
      })
    )
    .describe('Directory entries'),
  totalEntries: NonNegInt.optional().describe('Total entries scanned'),
  totalFiles: NonNegInt.optional().describe('Total files'),
  totalDirectories: NonNegInt.optional().describe('Total directories'),
  truncated: z.boolean().optional().describe('Results were truncated'),
  stoppedReason: z.string().optional().describe('Why enumeration stopped'),
  skippedInaccessible: NonNegInt.optional().describe(
    'Inaccessible entries skipped'
  ),
  nextCursor: NextCursorSchema,
});

export const SearchFilesOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  root: z.string().optional().describe('Search root path'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('Relative path from search root'),
        size: NonNegInt.optional().describe('Size in bytes'),
        modified: z.string().optional().describe('ISO 8601 last modified time'),
      })
    )
    .describe('Matching files'),
  totalMatches: NonNegInt.optional().describe('Total matches found'),
  filesScanned: NonNegInt.optional().describe('Files scanned'),
  truncated: z.boolean().optional().describe('Results truncated'),
  skippedInaccessible: NonNegInt.optional().describe(
    'Inaccessible entries skipped'
  ),
  stoppedReason: z.string().optional().describe('Why search stopped early'),
  nextCursor: NextCursorSchema,
});

// Tree node recursive type for directory structure visualization
const TreeNodeSchema: z.ZodType = z.lazy(() =>
  z.strictObject({
    name: z.string().describe('Name'),
    type: FileTypeEnum.describe('Type'),
    relativePath: z.string().optional().describe('Relative path from root'),
    size: NonNegInt.optional().describe('Size (bytes)'),
    children: z
      .array(TreeNodeSchema)
      .optional()
      .describe('Child nodes (directories/symlinks)'),
  })
);

export const TreeOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  root: z.string().optional().describe('Root directory path'),
  tree: TreeNodeSchema.optional().describe('Tree structure'),
  ascii: z.string().optional().describe('ASCII tree representation'),
  truncated: z.boolean().optional().describe('Tree was truncated'),
  totalEntries: NonNegInt.optional().describe('Total entries in tree'),
});

// --- Read group: read, read_many ---

export const ReadFileOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  path: z.string().optional().describe('Resolved path'),
  content: z.string().optional().describe('File content'),
  truncated: z.boolean().optional().describe('Content was truncated'),
  resourceUri: z
    .string()
    .optional()
    .describe('Full content URI when truncated'),
  totalLines: NonNegInt.optional().describe('Total lines in file'),
  linesRead: NonNegInt.optional().describe('Lines returned'),
  hasMoreLines: z.boolean().optional().describe('More lines available'),
  head: PositiveInt.optional().describe('Head lines requested'),
  tail: PositiveInt.optional().describe('Tail lines requested'),
  startLine: PositiveInt.optional().describe('Start line'),
  endLine: PositiveInt.optional().describe('End line'),
  contentHash: z
    .string()
    .optional()
    .describe('SHA-256 of content (when includeHash)'),
});

export const ReadManyOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        content: z.string().optional().describe('Content'),
        truncated: z.boolean().optional().describe('Truncated?'),
        resourceUri: z.string().optional().describe('Full content URI'),
        totalLines: NonNegInt.optional().describe('Total lines'),
        linesRead: NonNegInt.optional().describe('Lines returned'),
        hasMoreLines: z.boolean().optional().describe('More lines available'),
        head: PositiveInt.optional().describe('Head lines requested'),
        tail: PositiveInt.optional().describe('Tail lines requested'),
        startLine: PositiveInt.optional().describe('Start line'),
        endLine: PositiveInt.optional().describe('End line'),
        truncationReason: z
          .enum(['head', 'tail', 'range', 'externalized'])
          .optional()
          .describe('Why content was truncated'),
        error: PerFileErrorSchema.optional().describe('Per-file error'),
      })
    )
    .describe('Per-file read results'),
  summary: OperationSummarySchema.describe('Operation summary'),
});

// --- Content search: grep, search_and_replace ---

export const GrepOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  matches: z
    .array(
      z.strictObject({
        file: z.string().describe('Relative file path'),
        line: PositiveInt.describe('Line number'),
        column: NonNegInt.optional().describe('Column offset'),
        content: z.string().describe('Matched line content'),
        matchCount: NonNegInt.optional().describe('Match count on this line'),
        contextBefore: z
          .array(z.string())
          .optional()
          .describe('Context lines before'),
        contextAfter: z
          .array(z.string())
          .optional()
          .describe('Context lines after'),
      })
    )
    .describe('Flat list of matches (sorted by file then line)'),
  totalMatches: NonNegInt.optional().describe('Total match count'),
  filesMatched: NonNegInt.optional().describe('Files with matches'),
  filesScanned: NonNegInt.optional().describe('Files scanned'),
  skippedTooLarge: NonNegInt.optional().describe('Files skipped (too large)'),
  skippedBinary: NonNegInt.optional().describe('Files skipped (binary)'),
  skippedInaccessible: NonNegInt.optional().describe(
    'Files skipped (inaccessible)'
  ),
  truncated: z.boolean().optional().describe('Results truncated'),
  stoppedReason: z
    .enum(['maxResults', 'maxFiles', 'timeout'])
    .optional()
    .describe('Why search stopped early'),
  resourceUri: z
    .string()
    .optional()
    .describe('Full results URI when truncated'),
});

export const SearchAndReplaceOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  matches: NonNegInt.describe('Total match count'),
  filesChanged: NonNegInt.describe('Files changed'),
  processedFiles: NonNegInt.describe('Files scanned'),
  failedFiles: NonNegInt.optional().describe('Files that failed'),
  failures: z
    .array(
      z.strictObject({
        path: z.string(),
        error: PerFileErrorSchema,
      })
    )
    .optional()
    .describe('Per-file failures'),
  changedFiles: z
    .array(z.strictObject({ path: z.string(), matches: NonNegInt }))
    .optional()
    .describe('Changed files with match counts'),
  changedFilesTruncated: z
    .boolean()
    .optional()
    .describe('changedFiles list was truncated'),
  diff: z
    .string()
    .optional()
    .describe('Unified diff (when returnDiff or dryRun)'),
  diffTruncated: z.boolean().optional().describe('Diff was truncated'),
  stoppedReason: z
    .string()
    .optional()
    .describe('Why enumeration stopped early'),
});

// --- Stat group: stat, stat_many ---

export const StatOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  file: FileInfoSchema.describe('File info'),
});

export const StatManyOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('Requested path'),
        info: FileInfoSchema.optional().describe('File info (when successful)'),
        error: PerFileErrorSchema.optional().describe('Error (when failed)'),
      })
    )
    .describe('Per-path results'),
  summary: OperationSummarySchema.describe('Operation summary'),
});

// --- Misc: hash, diff, patch, roots ---

export const HashOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  hash: Sha256Hex.describe('SHA-256 digest'),
  path: z.string().describe('Resolved path'),
  isDirectory: z.boolean().describe('True when hashing a directory'),
  fileCount: NonNegInt.optional().describe('Files hashed (directories only)'),
});

export const DiffFilesOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  diff: z.string().describe('Unified diff output (empty when identical)'),
  isIdentical: z.boolean().describe('True when files are identical'),
  stats: z
    .strictObject({
      additions: NonNegInt.describe('Lines added'),
      deletions: NonNegInt.describe('Lines deleted'),
      hunks: NonNegInt.describe('Hunk count'),
    })
    .optional()
    .describe('Diff statistics (absent when identical)'),
  truncated: z.boolean().optional().describe('Diff was truncated to resource'),
  resourceUri: z.string().optional().describe('Full diff URI when truncated'),
});

export const ApplyPatchOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  files: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        hunks: NonNegInt.describe('Hunks applied'),
        linesAdded: NonNegInt.optional().describe('Lines added'),
        linesRemoved: NonNegInt.optional().describe('Lines removed'),
      })
    )
    .describe('Per-file patch results'),
  summary: OperationSummarySchema.describe('Operation summary'),
});

export const RootsOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  roots: z
    .array(
      z.strictObject({
        uri: z.string().describe('Root URI'),
        name: z.string().optional().describe('Display name'),
      })
    )
    .describe('Allowed root directories'),
});

// --- Write group: write, edit, mkdir, mv, rm ---

export const WriteFileOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  path: z.string().optional().describe('Written file path'),
  bytesWritten: NonNegInt.describe('Bytes written'),
});

export const EditFileOutputSchema = z.strictObject({
  ok: z.boolean().describe('Success indicator'),
  path: z.string().describe('File path'),
  appliedEdits: NonNegInt.optional().describe('Edits applied'),
  linesAdded: NonNegInt.optional().describe('Lines added'),
  linesRemoved: NonNegInt.optional().describe('Lines removed'),
  diff: z.string().optional().describe('Unified diff of changes'),
  unmatchedEdits: z
    .array(z.string())
    .optional()
    .describe('oldText strings that had no match'),
  lineRange: z
    .tuple([PositiveInt, PositiveInt])
    .optional()
    .describe('[firstLine, lastLine] range modified'),
});

export const CreateDirectoryOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  created: z
    .array(
      z.strictObject({
        path: z.string().describe('Created directory path'),
        isNew: z.boolean().describe('Was directory newly created'),
      })
    )
    .describe('Created directories'),
  summary: OperationSummarySchema.describe('Operation summary'),
});

export const MoveFileOutputSchema = z.strictObject({
  ok: z.boolean().describe('Success indicator'),
  source: z
    .string()
    .optional()
    .describe('Resolved source (single-source moves)'),
  sources: z.array(z.string()).describe('Resolved sources that were moved'),
  destination: z.string().describe('Resolved destination'),
  failed: z
    .array(
      z.strictObject({
        source: z.string().describe('Failed source path'),
        error: PerFileErrorSchema.describe('Failure details'),
      })
    )
    .optional()
    .describe('Failed moves (partial failure)'),
});

export const DeleteOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  path: z.string().describe('Deleted path'),
  type: FileTypeEnum.optional().describe('Deleted item type'),
});
