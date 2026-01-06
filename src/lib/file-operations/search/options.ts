import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCHABLE_FILE_SIZE,
} from '../../constants.js';
import type { MatcherOptions, ScanFileOptions } from './scan-file.js';

interface SearchOptions {
  filePattern: string;
  excludePatterns: readonly string[];
  caseSensitive: boolean;
  maxResults: number;
  maxFileSize: number;
  maxFilesScanned: number;
  timeoutMs: number;
  skipBinary: boolean;
  contextLines: number;
  wholeWord: boolean;
  isLiteral: boolean;
  includeHidden: boolean;
  baseNameMatch: boolean;
  caseSensitiveFileMatch: boolean;
}

export interface SearchContentOptions extends Partial<SearchOptions> {
  signal?: AbortSignal;
}

type ResolvedOptions = SearchOptions;

export type WorkerScanOptions = ScanFileOptions & MatcherOptions;

const DEFAULTS: SearchOptions = {
  filePattern: '**/*',
  excludePatterns: [],
  caseSensitive: false,
  maxResults: DEFAULT_MAX_RESULTS,
  maxFileSize: MAX_SEARCHABLE_FILE_SIZE,
  maxFilesScanned: DEFAULT_SEARCH_MAX_FILES,
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  skipBinary: true,
  contextLines: 0,
  wholeWord: false,
  isLiteral: false,
  includeHidden: false,
  baseNameMatch: false,
  caseSensitiveFileMatch: true,
};

export function mergeOptions(partial: SearchContentOptions): ResolvedOptions {
  const { signal, ...rest } = partial;
  void signal; // signal handled externally via createTimedAbortSignal
  return { ...DEFAULTS, ...rest };
}

export function buildWorkerOptions(
  options: ResolvedOptions
): WorkerScanOptions {
  return {
    caseSensitive: options.caseSensitive,
    wholeWord: options.wholeWord,
    isLiteral: options.isLiteral,
    maxFileSize: options.maxFileSize,
    skipBinary: options.skipBinary,
    contextLines: options.contextLines,
  };
}
