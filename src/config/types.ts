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
    filesScanned: number;
    stoppedReason?: 'maxResults' | 'maxFiles' | 'timeout';
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

export interface MultipleFileInfoResult {
  path: string;
  info?: FileInfo;
  error?: string;
}

export interface GetMultipleFileInfoResult {
  results: MultipleFileInfoResult[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    totalSize: number;
  };
}

export const ErrorCode = {
  E_ACCESS_DENIED: 'E_ACCESS_DENIED',
  E_NOT_FOUND: 'E_NOT_FOUND',
  E_NOT_FILE: 'E_NOT_FILE',
  E_NOT_DIRECTORY: 'E_NOT_DIRECTORY',
  E_TOO_LARGE: 'E_TOO_LARGE',
  E_TIMEOUT: 'E_TIMEOUT',
  E_INVALID_PATTERN: 'E_INVALID_PATTERN',
  E_INVALID_INPUT: 'E_INVALID_INPUT',
  E_PERMISSION_DENIED: 'E_PERMISSION_DENIED',
  E_SYMLINK_NOT_ALLOWED: 'E_SYMLINK_NOT_ALLOWED',
  E_UNKNOWN: 'E_UNKNOWN',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
