import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Stats } from 'node:fs';

import fg from 'fast-glob';

interface DirentLike {
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
  excludePatterns: readonly string[];
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

function resolveGlobEngine(options: GlobEntriesOptions): GlobEngine {
  // Auto behavior: prefer node glob when compatible, fall back to fast-glob
  return canUseNodeGlob(options) ? 'node' : 'fast-glob';
}

function canUseNodeGlob(options: GlobEntriesOptions): boolean {
  if (typeof fsp.glob !== 'function') return false;
  if (options.includeHidden) return false;
  if (!options.caseSensitiveMatch) return false;
  if (options.suppressErrors) return false;
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

function resolveMatchPaths(
  rawPath: string,
  cwd: string
): { fullPath: string; relative: string } {
  const fullPath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(cwd, rawPath);
  const relative = path.isAbsolute(rawPath)
    ? path.relative(cwd, fullPath)
    : rawPath;
  return { fullPath, relative };
}

function shouldSkipHidden(
  includeHidden: boolean,
  relativePath: string
): boolean {
  return !includeHidden && isHiddenPath(relativePath);
}

async function readMatchStats(
  fullPath: string,
  followSymbolicLinks: boolean,
  suppressErrors: boolean | undefined
): Promise<Stats | null> {
  try {
    return followSymbolicLinks
      ? await fsp.stat(fullPath)
      : await fsp.lstat(fullPath);
  } catch (error) {
    if (suppressErrors) return null;
    throw error;
  }
}

function resolveEntryTypes(
  dirent: DirentLike,
  stats?: Stats
): { isFile: boolean; isDirectory: boolean } {
  return {
    isFile: stats ? stats.isFile() : dirent.isFile(),
    isDirectory: stats ? stats.isDirectory() : dirent.isDirectory(),
  };
}

function isDepthExceeded(
  maxDepth: number | undefined,
  relativePath: string,
  isDirectory: boolean
): boolean {
  if (typeof maxDepth !== 'number') return false;
  const depth = depthFromRelative(relativePath, isDirectory);
  return depth > maxDepth;
}

function buildGlobEntry(
  fullPath: string,
  stats: Stats,
  includeStats: boolean
): GlobEntry {
  return {
    path: fullPath,
    dirent: direntFromStats(stats),
    stats: includeStats ? stats : undefined,
  };
}

async function resolveNodeStats(
  fullPath: string,
  dirent: DirentLike,
  options: GlobEntriesOptions
): Promise<Stats | undefined | null> {
  const needStats =
    options.stats || (options.followSymbolicLinks && dirent.isSymbolicLink());
  if (!needStats) return undefined;
  return await readMatchStats(
    fullPath,
    options.followSymbolicLinks,
    options.suppressErrors
  );
}

function buildNodeEntry(
  fullPath: string,
  dirent: DirentLike,
  stats: Stats | undefined,
  includeStats: boolean
): GlobEntry {
  if (stats) {
    return buildGlobEntry(fullPath, stats, includeStats);
  }
  return {
    path: fullPath,
    dirent,
    stats: undefined,
  };
}

async function* fastGlobEntries(
  options: GlobEntriesOptions
): AsyncGenerator<GlobEntry> {
  const stream = fg.stream(options.pattern, {
    cwd: options.cwd,
    absolute: true,
    dot: options.includeHidden,
    ignore: [...options.excludePatterns],
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
    withFileTypes: true,
  });

  for await (const dirent of matches as AsyncIterable<
    DirentLike & { parentPath: string; name: string }
  >) {
    const fullPath = path.join(dirent.parentPath, dirent.name);
    const { relative } = resolveMatchPaths(fullPath, options.cwd);

    if (shouldSkipHidden(options.includeHidden, relative)) {
      continue;
    }

    const statsResult = await resolveNodeStats(fullPath, dirent, options);
    if (statsResult === null) continue;
    const stats = statsResult ?? undefined;
    const { isFile, isDirectory } = resolveEntryTypes(dirent, stats);

    // Check onlyFiles using the resolved type
    if (options.onlyFiles && !isFile) continue;
    if (isDepthExceeded(options.maxDepth, relative, isDirectory)) continue;

    yield buildNodeEntry(fullPath, dirent, stats, options.stats);
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
