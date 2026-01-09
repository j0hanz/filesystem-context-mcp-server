import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';

import { glob } from 'tinyglobby';

import {
  publishOpsTraceEnd,
  publishOpsTraceError,
  publishOpsTraceStart,
  shouldPublishOpsTrace,
} from '../observability/diagnostics.js';

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

function normalizePattern(pattern: string, baseNameMatch: boolean): string {
  const normalized = pattern.replace(/\\/gu, '/');
  if (!baseNameMatch) return normalized;
  if (normalized.includes('/')) return normalized;
  return `**/${normalized}`;
}

function normalizeIgnorePatterns(
  patterns: readonly string[]
): readonly string[] {
  return patterns.map((pattern) => pattern.replace(/\\/gu, '/'));
}

async function buildEntry(
  entryPath: string,
  options: GlobEntriesOptions
): Promise<GlobEntry | null> {
  try {
    const stats = options.followSymbolicLinks
      ? await fs.stat(entryPath)
      : await fs.lstat(entryPath);
    const result: GlobEntry = {
      path: entryPath,
      dirent: stats,
    };
    if (options.stats) result.stats = stats;
    return result;
  } catch (error) {
    if (options.suppressErrors) {
      return null;
    }
    throw error;
  }
}

async function* tinyGlobbyEntries(
  options: GlobEntriesOptions
): AsyncGenerator<GlobEntry> {
  const pattern = normalizePattern(options.pattern, options.baseNameMatch);
  const entries = await glob(pattern, {
    cwd: options.cwd,
    absolute: true,
    dot: options.includeHidden,
    ignore: normalizeIgnorePatterns(options.excludePatterns),
    followSymbolicLinks: options.followSymbolicLinks,
    onlyFiles: options.onlyFiles,
    deep: options.maxDepth ?? Number.POSITIVE_INFINITY,
    caseSensitiveMatch: options.caseSensitiveMatch,
    expandDirectories: false,
  });

  for (const entryPath of entries) {
    const entry = await buildEntry(entryPath, options);
    if (!entry) continue;
    yield entry;
  }
}

export async function* globEntries(
  options: GlobEntriesOptions
): AsyncGenerator<GlobEntry> {
  const engine = 'tinyglobby';

  const traceContext = shouldPublishOpsTrace()
    ? {
        op: 'globEntries',
        engine,
      }
    : undefined;
  if (traceContext) publishOpsTraceStart(traceContext);

  try {
    yield* tinyGlobbyEntries(options);
  } catch (error: unknown) {
    if (traceContext) publishOpsTraceError(traceContext, error);
    throw error;
  } finally {
    if (traceContext) publishOpsTraceEnd(traceContext);
  }
}
