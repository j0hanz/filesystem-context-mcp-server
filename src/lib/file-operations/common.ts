export function needsStatsForSort(sortBy: string): boolean {
  return sortBy === 'size' || sortBy === 'modified';
}

const collator = new Intl.Collator(undefined, { numeric: true });

export function withOptionalStoppedReason<T extends object, R extends string>(
  summary: T,
  stoppedReason: R | undefined
): T | (T & { stoppedReason: R }) {
  if (stoppedReason === undefined) {
    return summary;
  }
  return { ...summary, stoppedReason };
}

export interface DirentLike {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export type EntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface IndexedValue<T> {
  index: number;
  value: T;
}

export interface IndexedError {
  index: number;
  error: Error;
}

export function resolveEntryType(dirent: DirentLike): EntryType {
  if (dirent.isSymbolicLink()) return 'symlink';
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  return 'other';
}

export function resolveStopReason<R extends string>(options: {
  signal: AbortSignal;
  current: number;
  max: number;
  abortedReason: R;
  maxReason: R;
}): R | undefined {
  if (options.signal.aborted) return options.abortedReason;
  if (options.current >= options.max) return options.maxReason;
  return undefined;
}

export function compareStringValues(left?: string, right?: string): number {
  return collator.compare(left ?? '', right ?? '');
}

export function compareOptionalNumberDesc(
  left: number | undefined,
  right: number | undefined,
  tieBreak: () => number
): number {
  const diff = (right ?? 0) - (left ?? 0);
  if (diff !== 0) return diff;
  return tieBreak();
}

export function stableSortByDerivedString<T>(
  items: T[],
  derive: (item: T) => string,
  tieBreak: (left: T, right: T) => number
): void {
  const decorated: { item: T; derived: string; index: number }[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    decorated.push({
      item,
      derived: derive(item),
      index,
    });
  }

  decorated.sort((left, right) => {
    const derivedCompare = compareStringValues(left.derived, right.derived);
    if (derivedCompare !== 0) return derivedCompare;

    const tiedCompare = tieBreak(left.item, right.item);
    if (tiedCompare !== 0) return tiedCompare;

    return left.index - right.index;
  });

  for (let index = 0; index < decorated.length; index += 1) {
    const entry = decorated[index];
    if (!entry) continue;
    items[index] = entry.item;
  }
}

export function applyIndexedValues<T>(
  output: T[],
  results: readonly IndexedValue<T>[]
): void {
  for (const result of results) {
    if (result.index < 0 || result.index >= output.length) continue;
    output[result.index] = result.value;
  }
}

export function applyIndexedErrors<T>(options: {
  output: T[];
  errors: readonly IndexedError[];
  resolveIndex: (failureIndex: number) => number | undefined;
  buildValue: (resolvedIndex: number, error: Error) => T;
}): void {
  for (const failure of options.errors) {
    const resolvedIndex = options.resolveIndex(failure.index);
    if (resolvedIndex === undefined) continue;
    if (resolvedIndex < 0 || resolvedIndex >= options.output.length) continue;
    options.output[resolvedIndex] = options.buildValue(
      resolvedIndex,
      failure.error
    );
  }
}

export interface EntryAccessDependencies {
  normalizePath: (inputPath: string) => string;
  isPathWithinDirectories: (
    normalizedPath: string,
    rootDirectories: readonly string[]
  ) => boolean;
  isSensitivePath: (requestedPath: string, resolvedPath: string) => boolean;
  validateSymlinkPath: (
    inputPath: string,
    signal: AbortSignal
  ) => Promise<{ requestedPath: string; resolvedPath: string }>;
}

export async function isEntryAccessibleByType(
  entryPath: string,
  entryType: EntryType,
  rootDirectories: readonly string[],
  signal: AbortSignal,
  deps: EntryAccessDependencies
): Promise<boolean> {
  if (entryType !== 'symlink') {
    const normalizedPath = deps.normalizePath(entryPath);
    if (!deps.isPathWithinDirectories(normalizedPath, rootDirectories)) {
      return false;
    }
    return !deps.isSensitivePath(entryPath, normalizedPath);
  }

  try {
    const validated = await deps.validateSymlinkPath(entryPath, signal);
    return !deps.isSensitivePath(
      validated.requestedPath,
      validated.resolvedPath
    );
  } catch {
    return false;
  }
}
