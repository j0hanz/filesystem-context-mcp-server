import type {
  ContentMatch,
  SearchContentResult,
} from '../../../config/types.js';

export interface SearchOptions {
  maxResults: number;
  contextLines: number;
  deadlineMs?: number;
  currentMatchCount: number;
  isLiteral?: boolean;
  searchString?: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  maxFileSize: number;
  skipBinary: boolean;
  searchPattern: string;
}

export interface ScanResult {
  matches: ContentMatch[];
  linesSkippedDueToRegexTimeout: number;
  fileHadMatches: boolean;
  skippedTooLarge: boolean;
  skippedBinary: boolean;
  scanned: boolean;
}

export interface SearchState {
  matches: ContentMatch[];
  filesScanned: number;
  filesMatched: number;
  skippedTooLarge: number;
  skippedBinary: number;
  skippedInaccessible: number;
  linesSkippedDueToRegexTimeout: number;
  truncated: boolean;
  stoppedReason: SearchContentResult['summary']['stoppedReason'];
}
