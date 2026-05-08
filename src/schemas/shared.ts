import { z } from 'zod/v4';

import { FileType as FileTypeEnum, IsoDateTime, NonNegInt } from './fields.js';

export const FileInfoSchema = z
  .strictObject({
    name: z.string().describe('Name'),
    path: z.string().describe('Absolute path'),
    type: FileTypeEnum.describe('Type'),
    size: NonNegInt.describe('Size (bytes)'),
    tokenEstimate: NonNegInt.optional().describe('Est. tokens (size÷4)'),
    created: IsoDateTime.describe('Created'),
    modified: IsoDateTime.describe('Modified'),
    accessed: IsoDateTime.describe('Accessed'),
    permissions: z.string().describe('Permissions'),
    isHidden: z.boolean().describe('Hidden?'),
    mimeType: z.string().optional().describe('MIME type'),
    symlinkTarget: z.string().optional().describe('Target (symlink)'),
  })
  .meta({ id: 'FileInfo', title: 'File Info' });

export const OperationSummarySchema = z
  .strictObject({
    total: NonNegInt.describe('Total'),
    succeeded: NonNegInt.describe('Succeeded'),
    failed: NonNegInt.describe('Failed'),
  })
  .meta({ id: 'OperationSummary', title: 'Operation Summary' });

export const PerFileErrorSchema = z
  .strictObject({
    code: z.string().describe('Error code'),
    message: z.string().describe('Error message'),
    path: z.string().optional().describe('Path involved'),
    suggestion: z.string().optional().describe('Suggested fix'),
  })
  .meta({ id: 'PerFileError', title: 'Per-File Error' });

interface ReadRangeDescriptions {
  head: string;
  tail: string;
  startLine: string;
  endLine: string;
}

export function createReadRangeFields(descs: ReadRangeDescriptions) {
  return {
    head: z
      .int32()
      .min(1, 'Min: 1')
      .max(100000, 'Max: 100,000')
      .optional()
      .describe(descs.head),
    tail: z
      .int32()
      .min(1, 'Min: 1')
      .max(100000, 'Max: 100,000')
      .optional()
      .describe(descs.tail),
    startLine: z.int32().min(1, 'Min: 1').optional().describe(descs.startLine),
    endLine: z.int32().min(1, 'Min: 1').optional().describe(descs.endLine),
  };
}

// Shared superRefine for read range mutual exclusion (runtime enforcement).
export function validateReadRange(
  value: {
    head?: number | undefined;
    tail?: number | undefined;
    startLine?: number | undefined;
    endLine?: number | undefined;
    offset?: number | undefined;
    length?: number | undefined;
  },
  ctx: z.RefinementCtx
): void {
  const hasHead = value.head !== undefined;
  const hasTail = value.tail !== undefined;
  const hasStart = value.startLine !== undefined;
  const hasEnd = value.endLine !== undefined;
  const hasByteRange = value.offset !== undefined || value.length !== undefined;

  if (hasHead && (hasStart || hasEnd)) {
    ctx.addIssue({
      code: 'custom',
      path: ['head'],
      message: "Cannot use 'head' with 'startLine'/'endLine'",
      params: {
        rule: 'head_no_line_range',
        conflictsWith: ['startLine', 'endLine'],
        suggestion:
          "Use either 'head' alone or 'startLine'/'endLine' together.",
      },
      input: value,
    });
  }
  if (hasTail && (hasHead || hasStart || hasEnd)) {
    ctx.addIssue({
      code: 'custom',
      path: ['tail'],
      message: "Cannot use 'tail' with 'head'/'startLine'/'endLine'",
      params: {
        rule: 'tail_exclusive',
        conflictsWith: ['head', 'startLine', 'endLine'],
        suggestion:
          "Use 'tail' alone or use 'startLine'/'endLine' without 'tail'.",
      },
      input: value,
    });
  }
  const effectiveStart = value.startLine ?? 1;
  if (value.endLine !== undefined && value.endLine < effectiveStart) {
    ctx.addIssue({
      code: 'custom',
      path: ['endLine'],
      message: "'endLine' must be >= 'startLine'",
      params: {
        rule: 'endLine_gte_startLine',
        conflictsWith: ['startLine'],
        suggestion:
          'Set endLine to a value greater than or equal to startLine.',
      },
      input: value,
    });
  }
  if (hasByteRange && (hasHead || hasTail || hasStart || hasEnd)) {
    ctx.addIssue({
      code: 'custom',
      path: ['offset'],
      message:
        "Cannot use 'offset'/'length' with line-based params (head/tail/startLine/endLine)",
      params: {
        rule: 'byte_range_no_line_params',
        conflictsWith: ['head', 'tail', 'startLine', 'endLine'],
        suggestion:
          "Use 'offset'/'length' alone; do not combine with line-based params.",
      },
      input: value,
    });
  }
}

// Shared optional boolean inputs used across multiple tools.
export function defaultFalseBoolean(description: string) {
  return z.boolean().optional().default(false).describe(description);
}

// Shared filter inputs reused by ls/find/tree/grep/search_and_replace.
export const includeHiddenField = () =>
  defaultFalseBoolean('Include hidden items (starting with .)');
export const includeIgnoredField = () =>
  defaultFalseBoolean('Include ignored items (node_modules, .git, etc).');

export const ContinuationSchema = z
  .strictObject({
    tool: z.string().describe('Tool name to call'),
    args: z.record(z.string(), z.unknown()).describe('Ready-to-use arguments'),
    hint: z.string().describe('One sentence: what data remains'),
  })
  .meta({ id: 'Continuation', title: 'Continuation' });

// Opaque base-64 JSON cursor — treat as opaque; do not parse or construct manually.
// `ls` cursors are snapshot-backed (5 min TTL, expire on eviction/restart).
// `find` cursors are offset-based (re-runs the query on each page request).
export const CursorSchema = z
  .base64url()
  .optional()
  .describe(
    'Pagination cursor from a previous response. Treat as opaque. ' +
      '`ls` cursors are snapshot-backed (expire after ~5 min or restart); ' +
      '`find` cursors are offset-based and re-run the query each page.'
  );

export const NextCursorSchema = z
  .base64url()
  .optional()
  .describe('Cursor for the next page; absent on the final page.');
