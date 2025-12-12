import { z } from 'zod';

import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_RESULTS,
  DEFAULT_TOP_N,
  DEFAULT_TREE_DEPTH,
  MAX_MEDIA_FILE_SIZE,
  MAX_TEXT_FILE_SIZE,
} from '../lib/constants.js';

export const ListDirectoryInputSchema = {
  path: z
    .string()
    .min(1, 'Path cannot be empty')
    .describe('Directory path to list'),
  recursive: z.boolean().optional().default(false).describe('List recursively'),
  includeHidden: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include hidden files'),
  maxDepth: z
    .number()
    .int('maxDepth must be an integer')
    .min(0, 'maxDepth must be non-negative')
    .max(100, 'maxDepth cannot exceed 100')
    .optional()
    .default(DEFAULT_MAX_DEPTH)
    .describe('Maximum depth for recursive listing'),
  maxEntries: z
    .number()
    .int('maxEntries must be an integer')
    .min(1, 'maxEntries must be at least 1')
    .max(100000, 'maxEntries cannot exceed 100,000')
    .optional()
    .describe('Maximum number of entries to return (prevents huge responses)'),
  sortBy: z
    .enum(['name', 'size', 'modified', 'type'])
    .optional()
    .default('name')
    .describe('Sort entries by: name, size, modified, or type'),
  includeSymlinkTargets: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include symlink target paths for symbolic links'),
};

export const SearchFilesInputSchema = {
  path: z
    .string()
    .min(1, 'Path cannot be empty')
    .describe('Base directory to search from'),
  pattern: z
    .string()
    .min(1, 'Pattern cannot be empty')
    .max(1000, 'Pattern is too long (max 1000 characters)')
    .refine(
      (val) => {
        // Basic glob pattern validation
        try {
          // Check for potentially problematic patterns
          if (val.includes('**/**/**')) {
            return false; // Excessive nesting
          }
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Invalid glob pattern syntax' }
    )
    .describe('Glob pattern to match files (e.g., "**/*.ts")'),
  excludePatterns: z
    .array(z.string().max(500, 'Individual exclude pattern is too long'))
    .max(100, 'Too many exclude patterns (max 100)')
    .optional()
    .default([])
    .describe('Patterns to exclude'),
  maxResults: z
    .number()
    .int('maxResults must be an integer')
    .min(1, 'maxResults must be at least 1')
    .max(10000, 'maxResults cannot exceed 10,000')
    .optional()
    .describe('Maximum number of matches to return (prevents huge responses)'),
  sortBy: z
    .enum(['name', 'size', 'modified', 'path'])
    .optional()
    .default('path')
    .describe('Sort results by: name, size, modified, or path'),
  maxDepth: z
    .number()
    .int('maxDepth must be an integer')
    .min(1, 'maxDepth must be at least 1')
    .max(100, 'maxDepth cannot exceed 100')
    .optional()
    .describe('Maximum directory depth to search'),
};

// Base schema for reading a file with various options.
const ReadFileBaseSchema = z.object({
  path: z
    .string()
    .min(1, 'Path cannot be empty')
    .describe('Path to the file to read'),
  encoding: z
    .enum(['utf-8', 'utf8', 'ascii', 'base64', 'hex', 'latin1'])
    .optional()
    .default('utf-8')
    .refine(
      (val) =>
        ['utf-8', 'utf8', 'ascii', 'base64', 'hex', 'latin1'].includes(val),
      { message: 'Invalid encoding specified' }
    )
    .describe('File encoding'),
  maxSize: z
    .number()
    .int('maxSize must be an integer')
    .min(1, 'maxSize must be at least 1 byte')
    .max(100 * 1024 * 1024, 'maxSize cannot exceed 100MB')
    .optional()
    .default(MAX_TEXT_FILE_SIZE)
    .describe('Maximum file size in bytes (default 10MB)'),
  lineStart: z
    .number()
    .int('lineStart must be an integer')
    .min(1, 'lineStart must be at least 1 (1-indexed)')
    .optional()
    .describe('Start line (1-indexed) for reading a range'),
  lineEnd: z
    .number()
    .int('lineEnd must be an integer')
    .min(1, 'lineEnd must be at least 1')
    .optional()
    .describe('End line (inclusive) for reading a range'),
  head: z
    .number()
    .int('head must be an integer')
    .min(1, 'head must be at least 1')
    .max(100000, 'head cannot exceed 100,000 lines')
    .optional()
    .describe(
      'Read only the first N lines of the file (memory efficient for large files)'
    ),
  tail: z
    .number()
    .int('tail must be an integer')
    .min(1, 'tail must be at least 1')
    .max(100000, 'tail cannot exceed 100,000 lines')
    .optional()
    .describe(
      'Read only the last N lines of the file (memory efficient for large files)'
    ),
});

// Schema for reading a single file.
export const ReadFileInputSchema = ReadFileBaseSchema.shape;

// Schema for reading multiple files in one request.
const ReadMultipleFilesBaseSchema = z.object({
  paths: z
    .array(z.string().min(1, 'Path cannot be empty'))
    .min(1, 'At least one path is required')
    .max(100, 'Cannot read more than 100 files at once')
    .describe('Array of file paths to read'),
  encoding: z
    .enum(['utf-8', 'utf8', 'ascii', 'base64', 'hex', 'latin1'])
    .optional()
    .default('utf-8')
    .describe('File encoding'),
  maxSize: z
    .number()
    .int('maxSize must be an integer')
    .min(1, 'maxSize must be at least 1 byte')
    .max(100 * 1024 * 1024, 'maxSize cannot exceed 100MB')
    .optional()
    .default(MAX_TEXT_FILE_SIZE)
    .describe('Maximum file size in bytes per file (default 10MB)'),
  head: z
    .number()
    .int('head must be an integer')
    .min(1, 'head must be at least 1')
    .max(100000, 'head cannot exceed 100,000 lines')
    .optional()
    .describe('Read only the first N lines of each file'),
  tail: z
    .number()
    .int('tail must be an integer')
    .min(1, 'tail must be at least 1')
    .max(100000, 'tail cannot exceed 100,000 lines')
    .optional()
    .describe('Read only the last N lines of each file'),
});

export const ReadMultipleFilesInputSchema = ReadMultipleFilesBaseSchema.shape;

export const GetFileInfoInputSchema = {
  path: z
    .string()
    .min(1, 'Path cannot be empty')
    .describe('Path to get information about'),
};

export const SearchContentInputSchema = {
  path: z
    .string()
    .min(1, 'Path cannot be empty')
    .describe('Base directory to search in'),
  pattern: z
    .string()
    .min(1, 'Pattern cannot be empty')
    .max(1000, 'Pattern is too long (max 1000 characters)')
    .describe('Regular expression pattern to search for'),
  filePattern: z
    .string()
    .min(1, 'File pattern cannot be empty')
    .max(500, 'File pattern is too long')
    .optional()
    .default('**/*')
    .describe('Glob pattern to filter files'),
  excludePatterns: z
    .array(z.string().max(500, 'Individual exclude pattern is too long'))
    .max(100, 'Too many exclude patterns (max 100)')
    .optional()
    .default([])
    .describe('Glob patterns to exclude (e.g., "node_modules/**")'),
  caseSensitive: z
    .boolean()
    .optional()
    .default(false)
    .describe('Case sensitive search'),
  maxResults: z
    .number()
    .int('maxResults must be an integer')
    .min(1, 'maxResults must be at least 1')
    .max(10000, 'maxResults cannot exceed 10,000')
    .optional()
    .default(DEFAULT_MAX_RESULTS)
    .describe('Maximum number of results'),
  maxFileSize: z
    .number()
    .int('maxFileSize must be an integer')
    .min(1, 'maxFileSize must be at least 1 byte')
    .max(100 * 1024 * 1024, 'maxFileSize cannot exceed 100MB')
    .optional()
    .describe('Maximum file size in bytes to scan (defaults to 1MB)'),
  maxFilesScanned: z
    .number()
    .int('maxFilesScanned must be an integer')
    .min(1, 'maxFilesScanned must be at least 1')
    .max(100000, 'maxFilesScanned cannot exceed 100,000')
    .optional()
    .describe('Maximum number of files to scan before stopping'),
  timeoutMs: z
    .number()
    .int('timeoutMs must be an integer')
    .min(100, 'timeoutMs must be at least 100ms')
    .max(3600000, 'timeoutMs cannot exceed 1 hour')
    .optional()
    .describe('Timeout in milliseconds for the search operation'),
  skipBinary: z
    .boolean()
    .optional()
    .default(true)
    .describe('Skip likely-binary files (recommended)'),
  contextLines: z
    .number()
    .int('contextLines must be an integer')
    .min(0, 'contextLines must be non-negative')
    .max(10, 'contextLines cannot exceed 10')
    .optional()
    .default(0)
    .describe('Number of lines to include before and after each match (0-10)'),
  wholeWord: z
    .boolean()
    .optional()
    .default(false)
    .describe('Match whole words only (adds word boundaries to pattern)'),
  isLiteral: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Treat pattern as literal string (escape regex special characters)'
    ),
};

export const AnalyzeDirectoryInputSchema = {
  path: z
    .string()
    .min(1, 'Path cannot be empty')
    .describe('Directory to analyze'),
  maxDepth: z
    .number()
    .int('maxDepth must be an integer')
    .min(0, 'maxDepth must be non-negative')
    .max(100, 'maxDepth cannot exceed 100')
    .optional()
    .default(DEFAULT_MAX_DEPTH)
    .describe('Maximum depth to analyze'),
  topN: z
    .number()
    .int('topN must be an integer')
    .min(1, 'topN must be at least 1')
    .max(1000, 'topN cannot exceed 1000')
    .optional()
    .default(DEFAULT_TOP_N)
    .describe('Number of top items to return'),
  excludePatterns: z
    .array(z.string().max(500, 'Individual exclude pattern is too long'))
    .max(100, 'Too many exclude patterns (max 100)')
    .optional()
    .default([])
    .describe('Glob patterns to exclude (e.g., "node_modules", "*.log")'),
  includeHidden: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include hidden files and directories'),
};

export const DirectoryTreeInputSchema = {
  path: z
    .string()
    .min(1, 'Path cannot be empty')
    .describe('Directory path to build tree from'),
  maxDepth: z
    .number()
    .int('maxDepth must be an integer')
    .min(0, 'maxDepth must be non-negative')
    .max(50, 'maxDepth cannot exceed 50')
    .optional()
    .default(DEFAULT_TREE_DEPTH)
    .describe('Maximum depth to traverse (default 5)'),
  excludePatterns: z
    .array(z.string().max(500, 'Individual exclude pattern is too long'))
    .max(100, 'Too many exclude patterns (max 100)')
    .optional()
    .default([])
    .describe('Glob patterns to exclude (e.g., "node_modules", "*.log")'),
  includeHidden: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include hidden files and directories'),
  includeSize: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include file sizes in the tree'),
  maxFiles: z
    .number()
    .int('maxFiles must be an integer')
    .min(1, 'maxFiles must be at least 1')
    .max(100000, 'maxFiles cannot exceed 100,000')
    .optional()
    .describe('Maximum total number of files to include in the tree'),
};

export const ReadMediaFileInputSchema = {
  path: z
    .string()
    .min(1, 'Path cannot be empty')
    .describe('Path to the media file to read'),
  maxSize: z
    .number()
    .int('maxSize must be an integer')
    .min(1, 'maxSize must be at least 1 byte')
    .max(500 * 1024 * 1024, 'maxSize cannot exceed 500MB')
    .optional()
    .default(MAX_MEDIA_FILE_SIZE)
    .describe('Maximum file size in bytes (default 50MB)'),
};
