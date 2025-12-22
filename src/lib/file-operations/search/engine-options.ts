import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCHABLE_FILE_SIZE,
} from '../../constants.js';

export interface SearchOptions {
  filePattern: string;
  excludePatterns: string[];
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

function mergeDefined<T extends object>(defaults: T, overrides: Partial<T>): T {
  const entries = Object.entries(overrides).filter(
    ([, value]) => value !== undefined
  );
  const merged: T = {
    ...defaults,
    ...(Object.fromEntries(entries) as Partial<T>),
  };
  return merged;
}

export function buildSearchOptions(
  partialOptions: Partial<SearchOptions>
): SearchOptions {
  const defaults: SearchOptions = {
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

  return mergeDefined(defaults, partialOptions);
}

export function getDeadlineMs(options: SearchOptions): number | undefined {
  return options.timeoutMs ? Date.now() + options.timeoutMs : undefined;
}
