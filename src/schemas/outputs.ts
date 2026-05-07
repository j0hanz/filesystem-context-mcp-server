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
  ReadResultSchema,
  SearchSummarySchema,
} from './shared.js';

// --- List group: ls, find, tree ---

export const ListDirectoryOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  entries: z.array(FileInfoSchema).describe('File entries'),
  summary: OperationSummarySchema.describe('Operation summary'),
  nextCursor: NextCursorSchema,
});

export const SearchFilesOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  results: z.array(FileInfoSchema).describe('Matching files'),
  summary: SearchSummarySchema.describe('Search summary'),
  nextCursor: NextCursorSchema,
});

// Tree node recursive type for directory structure visualization
const TreeNodeSchema: z.ZodType = z.lazy(() =>
  z.strictObject({
    name: z.string().describe('Name'),
    type: FileTypeEnum.describe('Type'),
    size: NonNegInt.optional().describe('Size (bytes)'),
    children: z
      .array(TreeNodeSchema)
      .optional()
      .describe('Child nodes (directories/symlinks)'),
  })
);

export const TreeOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  root: TreeNodeSchema.describe('Tree root'),
  summary: OperationSummarySchema.describe('Operation summary'),
});

// --- Read group: read, read_many ---

export const ReadFileOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  result: ReadResultSchema.describe('Read result'),
});

const ReadManyOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  items: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        result: ReadResultSchema.describe('Read result for this item'),
      })
    )
    .describe('Results per file'),
  summary: OperationSummarySchema.describe('Operation summary'),
});

// --- Content search: grep, search_and_replace ---

const GrepOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  matches: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        matches: z
          .array(
            z.strictObject({
              lineNumber: PositiveInt.describe('Line number'),
              line: z.string().describe('Match line content'),
              column: PositiveInt.optional().describe('Column offset'),
            })
          )
          .describe('Matches in this file'),
      })
    )
    .describe('Matches per file'),
  summary: SearchSummarySchema.describe('Search summary'),
});

export const SearchAndReplaceOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  changes: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        replacements: NonNegInt.describe('Replacements made'),
        before: z.string().optional().describe('Content before (if --dry-run)'),
        after: z.string().optional().describe('Content after (if --dry-run)'),
      })
    )
    .describe('Changes per file'),
  summary: OperationSummarySchema.describe('Operation summary'),
});

// --- Stat group: stat, stat_many ---

const StatOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  file: FileInfoSchema.describe('File info'),
});

const StatManyOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  files: z.array(FileInfoSchema).describe('File info per path'),
  summary: OperationSummarySchema.describe('Operation summary'),
});

// --- Misc: hash, diff, patch, roots ---

const HashOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  hash: Sha256Hex.describe('SHA-256 digest'),
  file: FileInfoSchema.describe('File info'),
});

export const DiffFilesOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  diff: z.string().describe('Unified diff output'),
  stats: z
    .strictObject({
      filesChanged: NonNegInt.describe('Files changed'),
      additions: NonNegInt.describe('Lines added'),
      deletions: NonNegInt.describe('Lines deleted'),
    })
    .describe('Diff statistics'),
});

export const ApplyPatchOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  applied: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        hunks: NonNegInt.describe('Hunks applied'),
      })
    )
    .describe('Applied hunks per file'),
  summary: OperationSummarySchema.describe('Operation summary'),
});

const RootsOutputSchema = z.strictObject({
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
  file: FileInfoSchema.describe('Written file info'),
  bytesWritten: NonNegInt.describe('Bytes written'),
});

export const EditFileOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  file: FileInfoSchema.describe('Edited file info'),
  applied: NonNegInt.describe('Changes applied'),
  changes: z
    .array(
      z.strictObject({
        start: PositiveInt.describe('Start line'),
        end: PositiveInt.describe('End line'),
        action: z.enum(['insert', 'delete', 'replace']).describe('Action type'),
      })
    )
    .optional()
    .describe('Applied changes'),
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
  ok: z.literal(true).describe('Success indicator'),
  moves: z
    .array(
      z.strictObject({
        source: z.string().describe('Source path'),
        destination: z.string().describe('Destination path'),
        type: FileTypeEnum.describe('Item type'),
      })
    )
    .describe('Completed moves'),
  summary: OperationSummarySchema.describe('Operation summary'),
});

const DeleteOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  deleted: z
    .array(
      z.strictObject({
        path: z.string().describe('Deleted path'),
        type: FileTypeEnum.describe('Item type'),
      })
    )
    .describe('Deleted items'),
  summary: OperationSummarySchema.describe('Operation summary'),
});
