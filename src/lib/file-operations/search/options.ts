import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCHABLE_FILE_SIZE,
} from '../../constants.js';

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

export type ResolvedOptions = SearchOptions;

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
  const rest = { ...partial };
  delete rest.signal;
  return { ...DEFAULTS, ...rest };
}
