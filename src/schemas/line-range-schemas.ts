import { z } from 'zod';

import type { LineRangeOptions } from '../lib/line-range.js';
import { validateLineRange } from '../lib/line-range.js';

export const HeadLinesSchema = z
  .int({ error: 'head must be an integer' })
  .min(1, 'head must be at least 1')
  .max(100000, 'head cannot exceed 100,000 lines')
  .optional()
  .describe('Read only the first N lines');

export const TailLinesSchema = z
  .int({ error: 'tail must be an integer' })
  .min(1, 'tail must be at least 1')
  .max(100000, 'tail cannot exceed 100,000 lines')
  .optional()
  .describe('Read only the last N lines');

export const LineStartSchema = z
  .int({ error: 'lineStart must be an integer' })
  .min(1, 'lineStart must be at least 1 (1-indexed)')
  .optional()
  .describe('Start line (1-indexed) for reading a range');

export const LineEndSchema = z
  .int({ error: 'lineEnd must be an integer' })
  .min(1, 'lineEnd must be at least 1')
  .optional()
  .describe('End line (inclusive) for reading a range');

function resolveConflictField(options: LineRangeOptions): string {
  if (options.head !== undefined) return 'head';
  if (options.tail !== undefined) return 'tail';
  return 'lineStart';
}

export function applyLineRangeIssues(
  options: LineRangeOptions,
  ctx: z.RefinementCtx
): void {
  const issues = validateLineRange(options);
  if (issues.missingPair) {
    ctx.addIssue({
      code: 'custom',
      message: `Invalid lineRange: ${issues.missingPair.provided} requires ${issues.missingPair.missing} to also be specified`,
      path: [issues.missingPair.missing],
    });
  }

  if (issues.invalidOrder) {
    ctx.addIssue({
      code: 'custom',
      message: `Invalid lineRange: lineEnd (${issues.invalidOrder.end}) must be >= lineStart (${issues.invalidOrder.start})`,
      path: ['lineEnd'],
    });
  }

  if (issues.multipleModes) {
    ctx.addIssue({
      code: 'custom',
      message:
        'Cannot specify multiple of lineRange (lineStart + lineEnd), head, or tail simultaneously',
      path: [resolveConflictField(options)],
    });
  }
}
