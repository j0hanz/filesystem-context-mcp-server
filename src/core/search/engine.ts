import { readFile } from 'node:fs/promises';

import { buildGlobOptions, globEntries } from '../glob.js';
import type { PathGuard } from '../path.js';
import { escapeRegexLiteral } from '../primitives.js';

export interface SearchResult {
  file: string;
  line: number;
  content: string;
  matchCount?: number;
}

export type Regex = RegExp;
export interface RegexCompileOptions {
  caseSensitive?: boolean;
}

export function compileRegex(pattern: string, options: RegexCompileOptions = {}): RegExp {
  const flags = options.caseSensitive ? 'g' : 'gi';
  return new RegExp(pattern, flags);
}

export interface SearchContentOptions {
  caseSensitive?: boolean;
  isRegex?: boolean;
  maxResults?: number;
  filePattern?: string;
  excludePatterns?: string[];
  respectGitignore?: boolean;
  includeHidden?: boolean;
  maxDepth?: number;
  signal?: AbortSignal;
}

export async function searchContent(
  directory: string,
  pattern: string,
  options: SearchContentOptions,
  pathGuard: PathGuard,
): Promise<{
  basePath: string;
  matches: SearchResult[];
  summary: {
    matches: number;
    filesScanned: number;
    filesMatched: number;
    truncated: boolean;
  };
}> {
  const matches: SearchResult[] = [];
  const maxResults = options.maxResults ?? 100;

  const globOpts = buildGlobOptions({
    cwd: directory,
    pattern: options.filePattern ?? '**/*',
    excludePatterns: options.excludePatterns ?? [],
    includeHidden: Boolean(options.includeHidden),
    respectGitignore: Boolean(options.respectGitignore),
    maxDepth: options.maxDepth ?? 100,
  });

  const entries = globEntries(globOpts);

  const regexPattern = options.isRegex ? pattern || '' : escapeRegexLiteral(pattern || '');
  const regex = compileRegex(regexPattern, { caseSensitive: Boolean(options.caseSensitive) });

  let filesScanned = 0;
  let filesMatched = 0;
  let matchesFound = 0;

  for await (const entry of entries) {
    if (options.signal?.aborted) break;
    if (matches.length >= maxResults) break;

    if (entry.dirent.isDirectory()) continue;

    // Check if path is allowed
    try {
      await pathGuard.validateExistingPath(entry.path);
    } catch {
      continue; // Skip inaccessible
    }

    filesScanned++;

    try {
      const content = await readFile(entry.path, 'utf-8');
      const lines = content.split('\n');
      let matchedFile = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        regex.lastIndex = 0;
        if (regex.test(line)) {
          matchedFile = true;
          matchesFound++;
          matches.push({
            file: entry.path,
            line: i + 1,
            content: line,
            matchCount: 1,
          });
          if (matches.length >= maxResults) break;
        }
      }
      if (matchedFile) filesMatched++;
    } catch (_e) {
      // ignore read errors (e.g. binary files)
    }
  }

  return {
    basePath: directory,
    matches,
    summary: {
      matches: matchesFound,
      filesScanned,
      filesMatched,
      truncated: matches.length >= maxResults,
    },
  };
}

export async function searchFiles(
  directory: string,
  pattern: string,
  excludePatterns: string[],
  options: {
    maxResults?: number;
    includeHidden?: boolean;
    sortBy?: 'name' | 'size' | 'modified' | 'path';
    respectGitignore?: boolean;
    maxDepth?: number;
    signal?: AbortSignal;
  },
  pathGuard: PathGuard,
): Promise<{
  basePath: string;
  results: { path: string; size?: number; modified?: Date }[];
  summary: {
    matched: number;
    filesScanned: number;
    truncated: boolean;
    skippedInaccessible: number;
    stoppedReason?: 'timeout' | 'maxResults' | 'maxFiles';
  };
}> {
  const maxResults = options.maxResults ?? 100;
  const globOpts = buildGlobOptions({
    cwd: directory,
    pattern,
    excludePatterns,
    includeHidden: Boolean(options.includeHidden),
    respectGitignore: Boolean(options.respectGitignore),
    maxDepth: options.maxDepth ?? 100,
  });

  const entries = globEntries(globOpts);
  const results: { path: string; size?: number; modified?: Date }[] = [];
  let filesScanned = 0;
  let skippedInaccessible = 0;

  for await (const entry of entries) {
    if (options.signal?.aborted) break;
    if (results.length >= maxResults) break;

    try {
      await pathGuard.validateExistingPath(entry.path);
    } catch {
      skippedInaccessible++;
      continue;
    }

    filesScanned++;
    const resultObj: { path: string; size?: number; modified?: Date } = { path: entry.path };
    if (entry.stats?.size !== undefined) resultObj.size = entry.stats.size;
    if (entry.stats?.mtime !== undefined) resultObj.modified = entry.stats.mtime;
    results.push(resultObj);
  }

  // Sorting
  if (options.sortBy) {
    results.sort((a, b) => {
      if (options.sortBy === 'size') {
        return (b.size ?? 0) - (a.size ?? 0);
      }
      if (options.sortBy === 'modified') {
        return (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0);
      }
      if (options.sortBy === 'name') {
        const aName = a.path.split(/[/\\]/).pop() ?? '';
        const bName = b.path.split(/[/\\]/).pop() ?? '';
        return aName.localeCompare(bName);
      }
      return a.path.localeCompare(b.path);
    });
  }

  return {
    basePath: directory,
    results,
    summary: {
      matched: results.length,
      filesScanned,
      truncated: results.length >= maxResults,
      skippedInaccessible,
      ...(results.length >= maxResults ? { stoppedReason: 'maxResults' } : {}),
    },
  };
}
