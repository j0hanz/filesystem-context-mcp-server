import type { Stats } from 'node:fs';

import fg from 'fast-glob';

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

type FastGlobEntry = fg.Entry;

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

export async function* globEntries(
  options: GlobEntriesOptions
): AsyncGenerator<GlobEntry> {
  const engine = 'fast-glob';

  const traceContext = shouldPublishOpsTrace()
    ? {
        op: 'globEntries',
        engine,
      }
    : undefined;
  if (traceContext) publishOpsTraceStart(traceContext);

  try {
    yield* fastGlobEntries(options);
  } catch (error: unknown) {
    if (traceContext) publishOpsTraceError(traceContext, error);
    throw error;
  } finally {
    if (traceContext) publishOpsTraceEnd(traceContext);
  }
}
