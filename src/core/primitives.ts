import { delimiter } from 'node:path';

/**
 * Minimal shared primitives with no intra-package dependencies.
 * Kept separate to avoid import cycles between observability.ts and util.ts.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The four filesystem entry types. Produced by `resolveEntryType` (glob.ts)
 *  and `getFileType` (fs.ts); published as the `FileType` schema. */
export const ENTRY_TYPES = ['file', 'directory', 'symlink', 'other'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export function parseTrueEnvFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim().toLowerCase();
  return trimmed === 'true' || trimmed === '1';
}

export function escapeRegexLiteral(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseEnvDirList(envVar: string): string[] {
  const val = process.env[envVar];
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
