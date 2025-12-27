import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from '../constants.js';
import { mergeDefined } from '../merge-defined.js';

export interface SearchFilesOptions {
  maxResults?: number;
  sortBy?: 'name' | 'size' | 'modified' | 'path';
  maxDepth?: number;
  maxFilesScanned?: number;
  timeoutMs?: number;
  baseNameMatch?: boolean;
  skipSymlinks?: boolean;
  includeHidden?: boolean;
}

interface NormalizedSearchFilesOptions {
  effectiveMaxResults: number;
  sortBy: 'name' | 'size' | 'modified' | 'path';
  maxDepth?: number;
  maxFilesScanned: number;
  deadlineMs?: number;
  baseNameMatch: boolean;
  skipSymlinks: boolean;
  includeHidden: boolean;
}

export function normalizeSearchFilesOptions(
  options: SearchFilesOptions
): NormalizedSearchFilesOptions {
  const defaults: Required<Omit<SearchFilesOptions, 'maxDepth'>> & {
    maxDepth: number | undefined;
  } = {
    maxResults: DEFAULT_MAX_RESULTS,
    sortBy: 'path',
    maxDepth: undefined,
    maxFilesScanned: DEFAULT_SEARCH_MAX_FILES,
    timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
    baseNameMatch: false,
    skipSymlinks: true,
    includeHidden: false,
  };
  const merged = mergeDefined(defaults, options);
  return {
    effectiveMaxResults: merged.maxResults,
    sortBy: merged.sortBy,
    maxDepth: merged.maxDepth,
    maxFilesScanned: merged.maxFilesScanned,
    deadlineMs: merged.timeoutMs ? Date.now() + merged.timeoutMs : undefined,
    baseNameMatch: merged.baseNameMatch,
    skipSymlinks: merged.skipSymlinks,
    includeHidden: merged.includeHidden,
  };
}

export function buildScanOptions(normalized: {
  deadlineMs?: number;
  maxFilesScanned: number;
  effectiveMaxResults: number;
}): {
  deadlineMs?: number;
  maxFilesScanned: number;
  maxResults: number;
} {
  return {
    deadlineMs: normalized.deadlineMs,
    maxFilesScanned: normalized.maxFilesScanned,
    maxResults: normalized.effectiveMaxResults,
  };
}
