import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { normalizePath } from '../path-utils.js';

const PATH_SEPARATOR = process.platform === 'win32' ? '\\' : '/';

let allowedDirectories: string[] = [];

export const RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

export function normalizeForComparison(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function stripTrailingSeparator(normalized: string): string {
  return normalized.endsWith(PATH_SEPARATOR)
    ? normalized.slice(0, -1)
    : normalized;
}

function normalizeAllowedDirectory(dir: string): string {
  const normalized = normalizePath(dir);
  if (normalized.length === 0) return '';

  const { root } = path.parse(normalized);
  const isRoot =
    normalizeForComparison(root) === normalizeForComparison(normalized);
  if (isRoot) return root;

  return stripTrailingSeparator(normalized);
}

export function setAllowedDirectories(dirs: string[]): void {
  const normalized = dirs
    .map(normalizeAllowedDirectory)
    .filter((d) => d.length > 0);
  allowedDirectories = [...new Set(normalized)];
}

export function getAllowedDirectories(): string[] {
  return [...allowedDirectories];
}

export function isPathWithinDirectories(
  normalizedPath: string,
  allowedDirs: string[]
): boolean {
  const candidate = normalizeForComparison(normalizedPath);
  return allowedDirs.some((allowedDir) => {
    const allowed = normalizeForComparison(allowedDir);
    const root = normalizeForComparison(path.parse(allowedDir).root);
    if (allowed === root) {
      return candidate.startsWith(allowed);
    }
    return (
      candidate === allowed || candidate.startsWith(allowed + PATH_SEPARATOR)
    );
  });
}

export function isPathWithinAllowedDirectories(
  normalizedPath: string
): boolean {
  return isPathWithinDirectories(normalizedPath, allowedDirectories);
}

async function expandAllowedDirectories(dirs: string[]): Promise<string[]> {
  const expanded: string[] = [];

  for (const dir of dirs) {
    const normalized = normalizeAllowedDirectory(dir);
    if (!normalized) continue;
    expanded.push(normalized);

    const normalizedReal = await resolveRealPath(normalized);
    if (normalizedReal && shouldAddRealPath(normalized, normalizedReal)) {
      expanded.push(normalizedReal);
    }
  }

  return [...new Set(expanded)];
}

async function resolveRealPath(normalized: string): Promise<string | null> {
  try {
    const realPath = await fs.realpath(normalized);
    return normalizeAllowedDirectory(realPath);
  } catch {
    return null;
  }
}

function shouldAddRealPath(
  normalized: string,
  normalizedReal: string | null
): boolean {
  if (!normalizedReal) return false;
  return (
    normalizeForComparison(normalizedReal) !==
    normalizeForComparison(normalized)
  );
}

export async function setAllowedDirectoriesResolved(
  dirs: string[]
): Promise<void> {
  const expanded = await expandAllowedDirectories(dirs);
  setAllowedDirectories(expanded);
}
