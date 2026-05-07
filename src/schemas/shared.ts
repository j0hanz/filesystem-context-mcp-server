import type { ZodType } from 'zod/v4';
import { z } from 'zod/v4';

import {
  ErrorCodeEnum,
  FileType as FileTypeEnum,
  IsoDateTime,
  NonNegInt,
  PositiveInt,
} from './fields.js';

function reg<T extends ZodType>(schema: T, id: string): T {
  z.globalRegistry.add(schema, { id });
  return schema;
}

export const FileInfoSchema = reg(
  z.strictObject({
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
  }),
  'FileInfo'
);

export const ErrorSchema = reg(
  z.strictObject({
    code: ErrorCodeEnum.describe('Error code (e.g. NOT_FOUND)'),
    message: z.string().describe('Human-readable message'),
    path: z.string().optional().describe('Relevant path'),
    suggestion: z.string().optional().describe('Fix suggestion'),
  }),
  'Error'
);

export const OperationSummarySchema = reg(
  z.strictObject({
    total: NonNegInt.describe('Total'),
    succeeded: NonNegInt.describe('Succeeded'),
    failed: NonNegInt.describe('Failed'),
  }),
  'OperationSummary'
);

export const SearchSummarySchema = reg(
  z.strictObject({
    totalMatches: NonNegInt.optional().describe('Total matches found'),
    truncated: z.boolean().optional().describe('Results truncated?'),
    resourceUri: z.string().optional().describe('Full results URI'),
  }),
  'SearchSummary'
);

// Common read-result fields shared by read and read_many item responses.
export const ReadResultSchema = reg(
  z.strictObject({
    content: z.string().optional().describe('Content'),
    truncated: z.boolean().optional().describe('Truncated?'),
    resourceUri: z.string().optional().describe('Full content URI'),
    totalLines: NonNegInt.optional().describe('Total lines'),
    head: PositiveInt.optional().describe('Head lines'),
    tail: PositiveInt.optional().describe('Tail lines'),
    startLine: PositiveInt.optional().describe('Start line'),
    endLine: PositiveInt.optional().describe('End line'),
    linesRead: NonNegInt.optional().describe('Lines read'),
    hasMoreLines: z.boolean().optional().describe('More lines?'),
  }),
  'ReadResult'
);

// Shared read-range input fields (head/tail/startLine/endLine) used in read and read_many.
export interface ReadRangeFields {
  head: ReturnType<typeof z.int>['optional'] extends (
    ...args: unknown[]
  ) => infer R
    ? R
    : never;
  tail: ReturnType<typeof z.int>['optional'] extends (
    ...args: unknown[]
  ) => infer R
    ? R
    : never;
  startLine: ReturnType<typeof z.int>['optional'] extends (
    ...args: unknown[]
  ) => infer R
    ? R
    : never;
  endLine: ReturnType<typeof z.int>['optional'] extends (
    ...args: unknown[]
  ) => infer R
    ? R
    : never;
}

interface ReadRangeDescriptions {
  head: string;
  tail: string;
  startLine: string;
  endLine: string;
}

export function createReadRangeFields(descs: ReadRangeDescriptions) {
  return {
    head: z
      .int({ error: 'Must be integer' })
      .min(1, 'Min: 1')
      .max(100000, 'Max: 100,000')
      .optional()
      .describe(descs.head),
    tail: z
      .int({ error: 'Must be integer' })
      .min(1, 'Min: 1')
      .max(100000, 'Max: 100,000')
      .optional()
      .describe(descs.tail),
    startLine: z
      .int({ error: 'Must be integer' })
      .min(1, 'Min: 1')
      .optional()
      .describe(descs.startLine),
    endLine: z
      .int({ error: 'Must be integer' })
      .min(1, 'Min: 1')
      .optional()
      .describe(descs.endLine),
  };
}

// Shared superRefine for read range mutual exclusion (runtime enforcement).
export function validateReadRange(
  value: {
    head?: number | undefined;
    tail?: number | undefined;
    startLine?: number | undefined;
    endLine?: number | undefined;
  },
  ctx: z.RefinementCtx
): void {
  const hasHead = value.head !== undefined;
  const hasTail = value.tail !== undefined;
  const hasStart = value.startLine !== undefined;
  const hasEnd = value.endLine !== undefined;

  if (hasHead && (hasStart || hasEnd)) {
    ctx.addIssue({
      code: 'custom',
      path: ['head'],
      message: "Cannot use 'head' with 'startLine'/'endLine'",
      input: value,
    });
  }
  if (hasTail && (hasHead || hasStart || hasEnd)) {
    ctx.addIssue({
      code: 'custom',
      path: ['tail'],
      message: "Cannot use 'tail' with 'head'/'startLine'/'endLine'",
      input: value,
    });
  }
  const effectiveStart = value.startLine ?? 1;
  if (value.endLine !== undefined && value.endLine < effectiveStart) {
    ctx.addIssue({
      code: 'custom',
      path: ['endLine'],
      message: "'endLine' must be >= 'startLine'",
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
