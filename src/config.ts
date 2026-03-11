export type FileType = 'file' | 'directory' | 'symlink' | 'other';

export interface FileInfo {
  readonly name: string;
  readonly path: string;
  readonly type: FileType;
  readonly size: number;
  readonly tokenEstimate?: number;
  readonly created: Date;
  readonly modified: Date;
  readonly accessed: Date;
  readonly permissions: string;
  readonly isHidden: boolean;
  readonly mimeType?: string;
  readonly symlinkTarget?: string;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly relativePath: string;
  readonly type: FileType;
  readonly size?: number;
  readonly modified?: Date;
  readonly symlinkTarget?: string;
}

export interface ListDirectoryResult {
  readonly path: string;
  readonly entries: readonly DirectoryEntry[];
  readonly summary: {
    readonly totalEntries: number;
    readonly entriesScanned?: number;
    readonly entriesVisible?: number;
    readonly totalFiles: number;
    readonly totalDirectories: number;
    readonly maxDepthReached: number;
    readonly truncated: boolean;
    readonly stoppedReason?: 'maxEntries' | 'aborted';
    readonly skippedInaccessible: number;
    readonly symlinksNotFollowed: number;
  };
}

export interface SearchResult {
  readonly path: string;
  readonly type: FileType;
  readonly size?: number;
  readonly modified?: Date;
}

export interface SearchFilesResult {
  readonly basePath: string;
  readonly pattern: string;
  readonly results: readonly SearchResult[];
  readonly summary: {
    readonly matched: number;
    readonly truncated: boolean;
    readonly skippedInaccessible: number;
    readonly filesScanned: number;
    readonly stoppedReason?: 'maxResults' | 'maxFiles' | 'timeout';
  };
}

export interface ContentMatch {
  readonly file: string;
  readonly line: number;
  readonly content: string;
  readonly contextBefore?: readonly string[];
  readonly contextAfter?: readonly string[];
  readonly matchCount: number;
}

export interface SearchContentResult {
  readonly basePath: string;
  readonly pattern: string;
  readonly filePattern: string;
  readonly matches: readonly ContentMatch[];
  readonly summary: {
    readonly filesScanned: number;
    readonly filesMatched: number;
    readonly matches: number;
    readonly truncated: boolean;
    readonly skippedTooLarge: number;
    readonly skippedBinary: number;
    readonly skippedInaccessible: number;
    readonly stoppedReason?: 'maxResults' | 'maxFiles' | 'timeout';
  };
}

export interface MultipleFileInfoResult {
  readonly path: string;
  readonly info?: FileInfo;
  readonly error?: string;
}

export interface GetMultipleFileInfoResult {
  readonly results: readonly MultipleFileInfoResult[];
  readonly summary: {
    readonly total: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly totalSize: number;
  };
}

export const ErrorCode = {
  E_ACCESS_DENIED: 'E_ACCESS_DENIED',
  E_NOT_FOUND: 'E_NOT_FOUND',
  E_NOT_FILE: 'E_NOT_FILE',
  E_NOT_DIRECTORY: 'E_NOT_DIRECTORY',
  E_TOO_LARGE: 'E_TOO_LARGE',
  E_TIMEOUT: 'E_TIMEOUT',
  E_CANCELLED: 'E_CANCELLED',
  E_INVALID_PATTERN: 'E_INVALID_PATTERN',
  E_INVALID_INPUT: 'E_INVALID_INPUT',
  E_PERMISSION_DENIED: 'E_PERMISSION_DENIED',
  E_SYMLINK_NOT_ALLOWED: 'E_SYMLINK_NOT_ALLOWED',
  E_UNKNOWN: 'E_UNKNOWN',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const BYTE_UNIT_LABELS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const unitIndex = Math.floor(Math.log(bytes) / Math.log(1024));
  const unit = BYTE_UNIT_LABELS[unitIndex] ?? 'B';
  const value = bytes / 1024 ** unitIndex;
  return `${parseFloat(value.toFixed(2))} ${unit}`;
}

export function joinLines(lines: readonly string[]): string {
  return lines.join('\n');
}

interface OperationSummary {
  truncated?: boolean;
  truncatedReason?: string;
}

export function formatOperationSummary(summary: OperationSummary): string {
  if (!summary.truncated) return '';
  return `\n[truncated: ${summary.truncatedReason ?? 'limit reached'}]`;
}
