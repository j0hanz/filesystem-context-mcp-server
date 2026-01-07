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

type FastGlobEntry = fg.Entry;

function isHiddenPath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/u).filter(Boolean);
  return segments.some(
    (segment) =>
      segment.length > 1 && segment.startsWith('.') && segment !== '..'
  );
}

function getNodePattern(options: GlobEntriesOptions): string {
  if (!options.baseNameMatch) return options.pattern;
  if (options.pattern.includes('/') || options.pattern.includes('\\')) {
    return options.pattern;
  }
  return `**/${options.pattern}`;
}

function getDepth(relativePath: string, isDirectory: boolean): number {
  const segments = relativePath.split(/[\\/]/u).filter(Boolean);
  if (segments.length === 0) return 0;
  return isDirectory ? segments.length : Math.max(segments.length - 1, 0);
}

function buildDirentFromStats(stats: Stats): DirentLike {
  return {
    isDirectory: () => stats.isDirectory(),
    isFile: () => stats.isFile(),
    isSymbolicLink: () => stats.isSymbolicLink(),
  };
}

function exceedsMaxDepth(
  maxDepth: number | undefined,
  relativePath: string,
  isDirectory: boolean
): boolean {
  if (typeof maxDepth !== 'number') return false;
  return getDepth(relativePath, isDirectory) > maxDepth;
}

async function resolveNodeStats(
  fullPath: string,
  dirent: DirentLike,
  options: GlobEntriesOptions
): Promise<Stats | undefined | null> {
  const needStats =
    options.stats || (options.followSymbolicLinks && dirent.isSymbolicLink());
  if (!needStats) return undefined;
  try {
    return options.followSymbolicLinks
      ? await fsp.stat(fullPath)
      : await fsp.lstat(fullPath);
  } catch (error) {
    if (options.suppressErrors) return null;
    throw error;
  }
}

async function resolveNodeEntry(
  dirent: DirentLike & { parentPath: string; name: string },
  options: GlobEntriesOptions
): Promise<GlobEntry | null> {
  const fullPath = path.resolve(options.cwd, dirent.parentPath, dirent.name);
  const relative = path.relative(options.cwd, fullPath);
  if (!options.includeHidden && isHiddenPath(relative)) {
    return null;
  }

  const statsResult = await resolveNodeStats(fullPath, dirent, options);
  if (statsResult === null) return null;
  const stats = statsResult ?? undefined;

  const isFile = stats ? stats.isFile() : dirent.isFile();
  const isDirectory = stats ? stats.isDirectory() : dirent.isDirectory();
  if (options.onlyFiles && !isFile) return null;
  if (exceedsMaxDepth(options.maxDepth, relative, isDirectory)) return null;

  return {
    path: fullPath,
    dirent: stats ? buildDirentFromStats(stats) : dirent,
    stats: options.stats ? stats : undefined,
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
  const pattern = getNodePattern(options);
  const matches = fsp.glob(pattern, {
    cwd: options.cwd,
    exclude: options.excludePatterns,
    withFileTypes: true,
  });

  for await (const dirent of matches as AsyncIterable<
    DirentLike & { parentPath: string; name: string }
  >) {
    const entry = await resolveNodeEntry(dirent, options);
    if (entry) yield entry;
  }
}

export async function* globEntries(
  options: GlobEntriesOptions
): AsyncGenerator<GlobEntry> {
  const useNode =
    typeof fsp.glob === 'function' &&
    !options.includeHidden &&
    options.caseSensitiveMatch &&
    !options.suppressErrors;
  if (useNode) {
    yield* nodeGlobEntries(options);
    return;
  }
  yield* fastGlobEntries(options);
}
