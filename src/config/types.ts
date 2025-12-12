import type { Buffer } from 'node:buffer';

/**
 * File and Directory Types
 */
export type FileType = 'file' | 'directory' | 'symlink' | 'other';

/**
 * Detailed metadata about a file or directory.
 */
export interface FileInfo {
  name: string;
  path: string;
  type: FileType;
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  permissions: string;
  isHidden: boolean;
  mimeType?: string;
  symlinkTarget?: string;
}

/**
 * An entry in a directory listing.
 */
export interface DirectoryEntry {
  name: string;
  /** Absolute, normalized path for the entry (realpath when applicable). */
  path: string;
  /** Path relative to the requested base path. */
  relativePath: string;
  type: FileType;
  size?: number;
  modified?: Date;
  /** Target path for symbolic links (only present when includeSymlinkTargets is true) */
  symlinkTarget?: string;
}

/**
 * Result of a directory listing operation.
 */
export interface ListDirectoryResult {
  path: string;
  entries: DirectoryEntry[];
  summary: {
    totalEntries: number;
    totalFiles: number;
    totalDirectories: number;
    maxDepthReached: number;
    truncated: boolean;
    skippedInaccessible: number;
    symlinksNotFollowed: number;
  };
}

/**
 * A single file match result from a glob search.
 */
export interface SearchResult {
  path: string;
  type: FileType;
  size?: number;
  modified?: Date;
}

/**
 * Result of a file search operation.
 */
export interface SearchFilesResult {
  basePath: string;
  pattern: string;
  results: SearchResult[];
  summary: {
    matched: number;
    truncated: boolean;
    skippedInaccessible: number;
  };
}

/**
 * A single content match within a file.
 */
export interface ContentMatch {
  file: string;
  line: number;
  content: string;
  contextBefore?: string[];
  contextAfter?: string[];
  matchCount: number;
}

/**
 * Result of a content search operation.
 */
export interface SearchContentResult {
  basePath: string;
  pattern: string;
  filePattern: string;
  matches: ContentMatch[];
  summary: {
    filesScanned: number;
    filesMatched: number;
    matches: number;
    truncated: boolean;
    skippedTooLarge: number;
    skippedBinary: number;
    skippedInaccessible: number;
    linesSkippedDueToRegexTimeout: number;
    stoppedReason?: 'maxResults' | 'maxFiles' | 'timeout';
  };
}

/**
 * Analysis data for a directory.
 */
export interface DirectoryAnalysis {
  path: string;
  totalFiles: number;
  totalDirectories: number;
  totalSize: number;
  fileTypes: Record<string, number>;
  largestFiles: { path: string; size: number }[];
  recentlyModified: { path: string; modified: Date }[];
  maxDepth: number;
}

/**
 * Result of a directory analysis operation.
 */
export interface AnalyzeDirectoryResult {
  analysis: DirectoryAnalysis;
  summary: {
    truncated: boolean;
    skippedInaccessible: number;
    symlinksNotFollowed: number;
  };
}

// =============================================================================
// Directory Tree Types
// =============================================================================

/**
 * An entry in a directory tree structure.
 */
export interface TreeEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
  children?: TreeEntry[];
}

/**
 * Result of a directory tree operation.
 */
export interface DirectoryTreeResult {
  tree: TreeEntry;
  summary: {
    totalFiles: number;
    totalDirectories: number;
    maxDepthReached: number;
    truncated: boolean;
    skippedInaccessible: number;
    symlinksNotFollowed: number;
  };
}

// =============================================================================
// Media File Types
// =============================================================================

/**
 * Result of reading a media/binary file.
 */
export interface MediaFileResult {
  path: string;
  mimeType: string;
  size: number;
  /** Base64-encoded file data */
  data: string;
  /** Image dimensions (if applicable) */
  width?: number;
  height?: number;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error codes used throughout the application.
 * Using const object instead of enum (better tree-shaking, no runtime overhead).
 */
export const ErrorCode = {
  E_ACCESS_DENIED: 'E_ACCESS_DENIED',
  E_NOT_FOUND: 'E_NOT_FOUND',
  E_NOT_FILE: 'E_NOT_FILE',
  E_NOT_DIRECTORY: 'E_NOT_DIRECTORY',
  E_TOO_LARGE: 'E_TOO_LARGE',
  E_BINARY_FILE: 'E_BINARY_FILE',
  E_TIMEOUT: 'E_TIMEOUT',
  E_INVALID_PATTERN: 'E_INVALID_PATTERN',
  E_INVALID_INPUT: 'E_INVALID_INPUT',
  E_PERMISSION_DENIED: 'E_PERMISSION_DENIED',
  E_SYMLINK_NOT_ALLOWED: 'E_SYMLINK_NOT_ALLOWED',
  E_PATH_TRAVERSAL: 'E_PATH_TRAVERSAL',
  E_UNKNOWN: 'E_UNKNOWN',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Detailed error information with suggestions.
 */
export interface DetailedError {
  code: ErrorCode;
  message: string;
  path?: string;
  suggestion?: string;
  details?: Record<string, unknown>;
}

/**
 * Standardized error response structure for MCP tools.
 * The index signature `[x: string]: unknown` is required for compatibility
 * with the MCP SDK's CallToolResult type.
 */
export interface ErrorResponse {
  [x: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent: {
    ok: false;
    error: {
      code: string;
      message: string;
      path?: string;
      suggestion?: string;
    };
  };
  isError: true;
}

// =============================================================================
// Server Types
// =============================================================================

/**
 * Result of parsing command-line arguments.
 */
export interface ParseArgsResult {
  allowedDirs: string[];
  allowCwd: boolean;
}

/**
 * Options for server configuration.
 */
export interface ServerOptions {
  allowCwd?: boolean;
}

// =============================================================================
// Image Types
// =============================================================================

/**
 * Image width and height dimensions.
 */
export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Function signature for parsing image dimensions from a buffer.
 */
export type ImageParser = (buffer: Buffer) => ImageDimensions | null;
