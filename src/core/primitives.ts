import { delimiter } from 'node:path';

/**
 * Minimal shared primitives with no intra-package dependencies.
 * Kept separate to avoid import cycles between observability.ts and util.ts.
 */

/** The four filesystem entry types; published as the `FileType` schema. */
export const ENTRY_TYPES = ['file', 'directory', 'symlink', 'other'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/** The three predicates both `Dirent` and `Stats` expose - all `resolveEntryType` needs. */
export interface DirentLike {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export function resolveEntryType(dirent: DirentLike): EntryType {
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  if (dirent.isSymbolicLink()) return 'symlink';
  return 'other';
}

const warnedFlagValues = new Set<string>();

/**
 * Parse a boolean env flag: `true`/`1` enable, `false`/`0`/empty disable.
 * Any other value warns once per var (when `name` is given) and reads as
 * false, so a typo like `FS_ALLOW_SENSITIVE=yes` is never silent.
 */
export function parseTrueEnvFlag(value: string | undefined, name?: string): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'true' || trimmed === '1') return true;
  if (name && trimmed !== '' && trimmed !== 'false' && trimmed !== '0') {
    const key = `${name}:${trimmed}`;
    if (!warnedFlagValues.has(key)) {
      warnedFlagValues.add(key);
      // console.error, not Logger: this module stays dependency-free to avoid
      // import cycles (same precedent as parseLogLevel in observability.ts).
      console.error(
        `[warning] Invalid ${name} value: ${value} (must be "true" or "1"). Using default: false`,
      );
    }
  }
  return false;
}

export function escapeRegexLiteral(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function splitDirList(val: string | undefined): string[] {
  if (!val) return [];
  return val
    .split(delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// ─── Path primitives (moved from path.ts to break the path↔sensitive cycle) ──

export const IS_WINDOWS = process.platform === 'win32';

export const isSlash = (code: number): boolean => code === 47 || code === 92;

export const isAlpha = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

export const toPosixPath = (value: string): string => value.replaceAll('\\', '/');
