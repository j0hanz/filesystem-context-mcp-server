import * as z from 'zod/v4';

/**
 * Minimal shared primitives with no intra-package dependencies.
 * Kept separate to avoid import cycles between observability.ts and util.ts.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

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
