import type { globEntries } from './glob-engine.js';

export interface GlobConfig {
  cwd: string;
  pattern: string;
  excludePatterns?: readonly string[];
  includeHidden?: boolean;
  baseNameMatch?: boolean;
  caseSensitiveMatch?: boolean; // Default true if undefined
  followSymbolicLinks?: boolean; // Default false
  onlyFiles?: boolean; // Default true
  stats?: boolean; // Default false
  maxDepth?: number;
  suppressErrors?: boolean;
}

/**
 * Builds standard options for globEntries to ensure consistency across search tools.
 */
export function buildGlobOptions(
  config: GlobConfig
): Parameters<typeof globEntries>[0] {
  const options: Parameters<typeof globEntries>[0] = {
    cwd: config.cwd,
    pattern: config.pattern,
    excludePatterns: config.excludePatterns ?? [],
    includeHidden: config.includeHidden ?? false,
    baseNameMatch: config.baseNameMatch ?? false,
    caseSensitiveMatch: config.caseSensitiveMatch ?? true,
    followSymbolicLinks: config.followSymbolicLinks ?? false,
    onlyFiles: config.onlyFiles ?? true,
    stats: config.stats ?? false,
  };

  if (config.suppressErrors) {
    options.suppressErrors = config.suppressErrors;
  }

  if (config.maxDepth !== undefined) {
    options.maxDepth = config.maxDepth;
  }

  return options;
}
