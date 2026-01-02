import { z } from 'zod';

import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_LIST_MAX_ENTRIES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCHABLE_FILE_SIZE,
  MAX_TEXT_FILE_SIZE,
} from '../lib/constants.js';
import type { LineRangeOptions } from '../lib/line-range.js';
import { validateLineRange } from '../lib/line-range.js';

export function isSafeGlobPattern(value: string): boolean {
  if (value.length === 0) return false;

  const absolutePattern = /^([/\\]|[A-Za-z]:[/\\]|\\\\)/u;
  if (absolutePattern.test(value)) {
    return false;
  }

  if (/[\\/]\.\.(?:[/\\]|$)/u.test(value) || value.startsWith('..')) {
    return false;
  }

  return true;
}

export const EncodingSchema = z
  .enum(['utf-8', 'utf8', 'ascii', 'base64', 'hex', 'latin1'])
  .optional()
  .default('utf-8')
  .describe('File encoding');

const MaxTextFileSizeSchema = z
  .int({ error: 'maxSize must be an integer' })
  .min(1, 'maxSize must be at least 1 byte')
  .max(100 * 1024 * 1024, 'maxSize cannot exceed 100MB')
  .optional()
  .default(MAX_TEXT_FILE_SIZE);

export const ReadFileMaxSizeSchema = MaxTextFileSizeSchema.describe(
  'Maximum file size in bytes (default 10MB)'
);

export const ReadMultipleFilesMaxSizeSchema = MaxTextFileSizeSchema.describe(
  'Maximum file size in bytes per file (default 10MB)'
);

export const ExcludePatternsSchema = z
  .array(
    z
      .string()
      .max(500, 'Individual exclude pattern is too long')
      .refine((val) => !val.includes('**/**/**'), {
        error: 'Pattern too deeply nested (max 2 levels of **)',
      })
  )
  .max(100, 'Too many exclude patterns (max 100)')
  .optional()
  .default(DEFAULT_EXCLUDE_PATTERNS);

export const ListExcludePatternsSchema = z
  .array(
    z
      .string()
      .max(500, 'Individual exclude pattern is too long')
      .refine((val) => !val.includes('**/**/**'), {
        error: 'Pattern too deeply nested (max 2 levels of **)',
      })
  )
  .max(100, 'Too many exclude patterns (max 100)')
  .optional()
  .default([]);

export const MaxDepthSchema = z
  .int({ error: 'maxDepth must be an integer' })
  .min(0, 'maxDepth must be non-negative')
  .max(100, 'maxDepth cannot exceed 100')
  .optional()
  .default(DEFAULT_MAX_DEPTH)
  .describe('Maximum directory depth to traverse');

export const MaxResultsSchema = z
  .int({ error: 'maxResults must be an integer' })
  .min(1, 'maxResults must be at least 1')
  .max(10000, 'maxResults cannot exceed 10,000')
  .optional()
  .default(DEFAULT_MAX_RESULTS)
  .describe('Maximum number of results to return');

export const MaxFilesScannedSchema = z
  .int({ error: 'maxFilesScanned must be an integer' })
  .min(1, 'maxFilesScanned must be at least 1')
  .max(100000, 'maxFilesScanned cannot exceed 100,000')
  .optional()
  .default(DEFAULT_SEARCH_MAX_FILES)
  .describe('Maximum number of files to scan before stopping');

export const TimeoutMsSchema = z
  .int({ error: 'timeoutMs must be an integer' })
  .min(100, 'timeoutMs must be at least 100ms')
  .max(3600000, 'timeoutMs cannot exceed 1 hour')
  .optional()
  .default(DEFAULT_SEARCH_TIMEOUT_MS)
  .describe('Timeout in milliseconds for the operation');

export const IncludeHiddenSchema = z
  .boolean()
  .optional()
  .default(false)
  .describe('Include hidden files and directories');

export const SortByFileSchema = z
  .enum(['name', 'size', 'modified', 'path'])
  .optional()
  .default('path')
  .describe('Sort results by: name, size, modified, or path');

export const SortByDirectorySchema = z
  .enum(['name', 'size', 'modified', 'type'])
  .optional()
  .default('name')
  .describe('Sort entries by: name, size, modified, or type');

export const MaxEntriesSchema = z
  .int({ error: 'maxEntries must be an integer' })
  .min(1, 'maxEntries must be at least 1')
  .max(100000, 'maxEntries cannot exceed 100,000')
  .optional()
  .default(DEFAULT_LIST_MAX_ENTRIES)
  .describe('Maximum number of entries to return (prevents huge responses)');

export const CaseSensitiveSchema = z
  .boolean()
  .optional()
  .default(false)
  .describe('Case sensitive search');

export const SkipBinarySchema = z
  .boolean()
  .optional()
  .default(true)
  .describe('Skip likely-binary files (recommended)');

export const BaseNameMatchSchema = z
  .boolean()
  .optional()
  .default(false)
  .describe(
    'If true, patterns without slashes match against basename only. Useful for finding files by name regardless of directory depth'
  );

export const MaxFileSizeSearchSchema = z
  .int({ error: 'maxFileSize must be an integer' })
  .min(1, 'maxFileSize must be at least 1 byte')
  .max(100 * 1024 * 1024, 'maxFileSize cannot exceed 100MB')
  .optional()
  .default(MAX_SEARCHABLE_FILE_SIZE)
  .describe('Maximum file size in bytes to scan (defaults to 1MB)');

export const ContextLinesSchema = z
  .int({ error: 'contextLines must be an integer' })
  .min(0, 'contextLines must be non-negative')
  .max(10, 'contextLines cannot exceed 10')
  .optional()
  .default(0)
  .describe('Number of lines to include before and after each match (0-10)');

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
