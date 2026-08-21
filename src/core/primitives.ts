import type { Icon } from '@modelcontextprotocol/server';

import { platform } from 'node:os';

import * as z from 'zod/v4';

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

const STRING_BOOL_SCHEMA = z.stringbool();

export function parseTrueEnvFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  return STRING_BOOL_SCHEMA.safeParse(value.trim().toLowerCase()).data === true;
}

export function escapeRegexLiteral(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseEnvDirList(envVar: string): string[] {
  const val = process.env[envVar];
  if (!val) return [];
  const sep = process.platform === 'win32' ? ';' : ':';
  return val
    .split(sep)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export type IconInfo = Icon & { mimeType: string };

export function withDefaultIcons<T extends object>(
  obj: T,
  iconInfo: IconInfo | undefined,
): T & { icons?: Icon[] } {
  if (!iconInfo) return obj;
  const existing = (obj as { icons?: Icon[] }).icons;
  if (existing && existing.length > 0) return obj;
  return { ...obj, icons: [{ src: iconInfo.src, mimeType: iconInfo.mimeType }] };
}

// ─── Path primitives (moved from path.ts to break the path↔sensitive cycle) ──

const WINDOWS_PATH_SEPARATOR = '\\';
const POSIX_PATH_SEPARATOR = '/';
export const IS_WINDOWS = platform() === 'win32';

const CHAR_FORWARD_SLASH = 47;
const CHAR_BACKWARD_SLASH = 92;

export function isSlash(code: number): boolean {
  return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
}

export function isAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

export function toPosixPath(value: string): string {
  return value.includes(WINDOWS_PATH_SEPARATOR)
    ? value.replaceAll(WINDOWS_PATH_SEPARATOR, POSIX_PATH_SEPARATOR)
    : value;
}
