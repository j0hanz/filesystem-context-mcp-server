import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Stats } from 'node:fs';

import type { DirectoryEntry } from '../../config/types.js';

export interface EntryTotals {
  files: number;
  directories: number;
}

export interface EntryCandidate {
  path: string;
  dirent: {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isFile(): boolean;
  };
  stats?: Stats;
}

export interface SymlinkOptions {
  includeSymlinkTargets: boolean;
}

function resolveEntryType(
  dirent: EntryCandidate['dirent']
): DirectoryEntry['type'] {
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isSymbolicLink()) return 'symlink';
  if (dirent.isFile()) return 'file';
  return 'other';
}

function resolveRelativePath(basePath: string, entryPath: string): string {
  return path.relative(basePath, entryPath) || path.basename(entryPath);
}

async function resolveSymlinkTarget(
  entryType: DirectoryEntry['type'],
  includeSymlinkTargets: boolean,
  entryPath: string
): Promise<string | undefined> {
  if (entryType !== 'symlink' || !includeSymlinkTargets) {
    return undefined;
  }
  return await fsp.readlink(entryPath).catch(() => undefined);
}

function updateTotals(type: DirectoryEntry['type'], totals: EntryTotals): void {
  if (type === 'file') totals.files += 1;
  if (type === 'directory') totals.directories += 1;
}

function buildDirectoryEntry(
  basePath: string,
  entry: { path: string; stats?: Stats },
  entryType: DirectoryEntry['type'],
  needsStats: boolean,
  symlinkTarget: string | undefined
): DirectoryEntry {
  const size =
    needsStats && entry.stats?.isFile() ? entry.stats.size : undefined;
  const modified = needsStats ? entry.stats?.mtime : undefined;
  return {
    name: path.basename(entry.path),
    path: entry.path,
    relativePath: resolveRelativePath(basePath, entry.path),
    type: entryType,
    ...(size !== undefined ? { size } : {}),
    ...(modified !== undefined ? { modified } : {}),
    ...(symlinkTarget !== undefined ? { symlinkTarget } : {}),
  };
}

export async function appendEntry(
  basePath: string,
  entry: EntryCandidate,
  options: SymlinkOptions,
  needsStats: boolean,
  totals: EntryTotals,
  entries: DirectoryEntry[]
): Promise<void> {
  const entryType = resolveEntryType(entry.dirent);
  const symlinkTarget = await resolveSymlinkTarget(
    entryType,
    options.includeSymlinkTargets,
    entry.path
  );
  updateTotals(entryType, totals);
  entries.push(
    buildDirectoryEntry(basePath, entry, entryType, needsStats, symlinkTarget)
  );
}
