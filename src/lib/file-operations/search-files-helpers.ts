import {
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from '../constants.js';

// Internal default for find tool - not exposed to MCP users
const INTERNAL_MAX_RESULTS = 1000;

export interface SearchFilesOptions {
  maxResults?: number;
  sortBy?: 'name' | 'size' | 'modified' | 'path';
  maxDepth?: number;
  maxFilesScanned?: number;
  timeoutMs?: number;
  baseNameMatch?: boolean;
  skipSymlinks?: boolean;
  includeHidden?: boolean;
  signal?: AbortSignal;
}

export type NormalizedOptions = Required<
  Omit<SearchFilesOptions, 'maxDepth' | 'sortBy' | 'signal'>
> & {
  maxDepth?: number;
  sortBy: NonNullable<SearchFilesOptions['sortBy']>;
};

export function normalizeOptions(
  options: SearchFilesOptions
): NormalizedOptions {
  const normalized: NormalizedOptions = {
    maxResults: options.maxResults ?? INTERNAL_MAX_RESULTS,
    sortBy: options.sortBy ?? 'path',
    maxFilesScanned: options.maxFilesScanned ?? DEFAULT_SEARCH_MAX_FILES,
    timeoutMs: options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    baseNameMatch: options.baseNameMatch ?? false,
    skipSymlinks: options.skipSymlinks ?? true,
    includeHidden: options.includeHidden ?? false,
  };
  if (options.maxDepth !== undefined) {
    normalized.maxDepth = options.maxDepth;
  }
  return normalized;
}
