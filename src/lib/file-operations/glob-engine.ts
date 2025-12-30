import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Stats } from 'node:fs';

import fg from 'fast-glob';

export interface DirentLike {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface GlobEntry {
  path: string;
  dirent: DirentLike;
  stats?: Stats;
}

export interface GlobEntriesOptions {
  cwd: string;
  pattern: string;
  excludePatterns: string[];
  includeHidden: boolean;
  baseNameMatch: boolean;
  caseSensitiveMatch: boolean;
  maxDepth?: number;
  followSymbolicLinks: boolean;
  onlyFiles: boolean;
  stats: boolean;
  suppressErrors?: boolean;
}

type GlobEngine = 'fast-glob' | 'node';

type FastGlobEntry = fg.Entry;

const RAW_GLOB_ENGINE =
  process.env.FILESYSTEM_CONTEXT_GLOB_ENGINE?.toLowerCase() ?? 'fast-glob';

function resolveGlobEngine(options: GlobEntriesOptions): GlobEngine {
  if (RAW_GLOB_ENGINE === 'node' || RAW_GLOB_ENGINE === 'node:fs') {
    return canUseNodeGlob(options) ? 'node' : 'fast-glob';
  }
  return 'fast-glob';
}

function canUseNodeGlob(options: GlobEntriesOptions): boolean {
  if (typeof fsp.glob !== 'function') return false;
  if (options.includeHidden) return false;
  if (!options.caseSensitiveMatch) return false;
  return true;
}

function normalizePattern(pattern: string, baseNameMatch: boolean): string {
  if (!baseNameMatch) return pattern;
  if (pattern.includes('/') || pattern.includes('\\')) return pattern;
  return `**/${pattern}`;
}

function isHiddenPath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/u).filter(Boolean);
  return segments.some(
    (segment) =>
      segment.length > 1 && segment.startsWith('.') && segment !== '..'
  );
}

function depthFromRelative(relativePath: string, isDirectory: boolean): number {
  const segments = relativePath.split(/[\\/]/u).filter(Boolean);
  if (segments.length === 0) return 0;
  return isDirectory ? segments.length : Math.max(segments.length - 1, 0);
}

function direntFromStats(stats: Stats): DirentLike {
  return {
    isDirectory: () => stats.isDirectory(),
    isFile: () => stats.isFile(),
    isSymbolicLink: () => stats.isSymbolicLink(),
  };
}

async function* fastGlobEntries(
  options: GlobEntriesOptions
): AsyncGenerator<GlobEntry> {
  const stream = fg.stream(options.pattern, {
    cwd: options.cwd,
    absolute: true,
    dot: options.includeHidden,
    ignore: options.excludePatterns,
    followSymbolicLinks: options.followSymbolicLinks,
    baseNameMatch: options.baseNameMatch,
    caseSensitiveMatch: options.caseSensitiveMatch,
    onlyFiles: options.onlyFiles,
    stats: options.stats,
    objectMode: true,
    deep: options.maxDepth ?? Number.POSITIVE_INFINITY,
    suppressErrors: options.suppressErrors,
  });

  for await (const entry of stream as AsyncIterable<
    FastGlobEntry | string | Buffer
  >) {
    if (typeof entry === 'string' || Buffer.isBuffer(entry)) continue;
    yield {
      path: entry.path,
      dirent: entry.dirent,
      stats: entry.stats,
    };
  }
}

async function* nodeGlobEntries(
  options: GlobEntriesOptions
): AsyncGenerator<GlobEntry> {
  const pattern = normalizePattern(options.pattern, options.baseNameMatch);
  const matches = fsp.glob(pattern, {
    cwd: options.cwd,
    exclude: options.excludePatterns,
  });

  for await (const match of matches as AsyncIterable<string>) {
    const rawPath = match;
    const fullPath = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(options.cwd, rawPath);
    const relative = path.isAbsolute(rawPath)
      ? path.relative(options.cwd, fullPath)
      : rawPath;

    if (!options.includeHidden && isHiddenPath(relative)) {
      continue;
    }

    let stats: Stats;
    try {
      stats = options.followSymbolicLinks
        ? await fsp.stat(fullPath)
        : await fsp.lstat(fullPath);
    } catch (error) {
      if (options.suppressErrors) continue;
      throw error;
    }

    if (options.onlyFiles && !stats.isFile()) {
      continue;
    }

    if (typeof options.maxDepth === 'number') {
      const depth = depthFromRelative(relative, stats.isDirectory());
      if (depth > options.maxDepth) {
        continue;
      }
    }

    yield {
      path: fullPath,
      dirent: direntFromStats(stats),
      stats: options.stats ? stats : undefined,
    };
  }
}

export async function* globEntries(
  options: GlobEntriesOptions
): AsyncGenerator<GlobEntry> {
  const engine = resolveGlobEngine(options);
  if (engine === 'node') {
    yield* nodeGlobEntries(options);
    return;
  }
  yield* fastGlobEntries(options);
}
