import type { Buffer } from 'node:buffer';

export type FileType = 'file' | 'directory' | 'symlink' | 'other';

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

export interface DirectoryEntry {
  name: string;
  path: string;
  relativePath: string;
  type: FileType;
  size?: number;
  modified?: Date;
  symlinkTarget?: string;
}

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

export interface SearchResult {
  path: string;
  type: FileType;
  size?: number;
  modified?: Date;
}

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

export interface ContentMatch {
  file: string;
  line: number;
  content: string;
  contextBefore?: string[];
  contextAfter?: string[];
  matchCount: number;
}

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

export interface AnalyzeDirectoryResult {
  analysis: DirectoryAnalysis;
  summary: {
    truncated: boolean;
    skippedInaccessible: number;
    symlinksNotFollowed: number;
  };
}

export interface TreeEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
  children?: TreeEntry[];
}

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

export interface MediaFileResult {
  path: string;
  mimeType: string;
  size: number;
  data: string;
  width?: number;
  height?: number;
}

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

export interface DetailedError {
  code: ErrorCode;
  message: string;
  path?: string;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export interface ErrorResponse {
  [key: string]: unknown;
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

export interface ParseArgsResult {
  allowedDirs: string[];
  allowCwd: boolean;
}

export interface ServerOptions {
  allowCwd?: boolean;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

export type ImageParser = (buffer: Buffer) => ImageDimensions | null;

export interface ValidatedPathDetails {
  requestedPath: string;
  resolvedPath: string;
  isSymlink: boolean;
}

export interface ScanFileResult {
  matches: ContentMatch[];
  linesSkippedDueToRegexTimeout: number;
  fileHadMatches: boolean;
}

export interface ParallelResult<R> {
  results: R[];
  errors: { index: number; error: Error }[];
}
