import type { ZodType } from 'zod/v4';
import { z } from 'zod/v4';

import { FileType as FileTypeEnum, IsoDateTime, NonNegInt } from './fields.js';

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

export const OperationSummarySchema = reg(
  z.strictObject({
    total: NonNegInt.describe('Total'),
    succeeded: NonNegInt.describe('Succeeded'),
    failed: NonNegInt.describe('Failed'),
  }),
  'OperationSummary'
);

export const PerFileErrorSchema = reg(
  z.strictObject({
    code: z.string().describe('Error code'),
    message: z.string().describe('Error message'),
    path: z.string().optional().describe('Path involved'),
    suggestion: z.string().optional().describe('Suggested fix'),
  }),
  'PerFileError'
);

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
