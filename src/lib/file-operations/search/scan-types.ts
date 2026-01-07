import type { ContentMatch } from '../../../config/types.js';

export interface MatcherOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  isLiteral: boolean;
}

export type Matcher = (line: string) => number;

export interface ScanFileOptions {
  maxFileSize: number;
  skipBinary: boolean;
  contextLines: number;
}

export interface ScanFileResult {
  readonly matches: readonly ContentMatch[];
  readonly matched: boolean;
  readonly skippedTooLarge: boolean;
  readonly skippedBinary: boolean;
}
