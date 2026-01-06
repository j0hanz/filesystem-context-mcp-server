import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { isPathWithinRoot, normalizePath } from '../path-utils.js';

const PATH_SEPARATOR = process.platform === 'win32' ? '\\' : '/';

export function normalizeForComparison(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function stripTrailingSeparator(normalized: string): string {
  return normalized.endsWith(PATH_SEPARATOR)
    ? normalized.slice(0, -1)
    : normalized;
}

function normalizeAllowedDirectory(dir: string): string {
  const normalized = normalizePath(dir.trim());
  if (normalized.length === 0) return '';

  const { root } = path.parse(normalized);
  const isRootPath =
    normalizeForComparison(root) === normalizeForComparison(normalized);
  if (isRootPath) return root;

  return stripTrailingSeparator(normalized);
}

let allowedDirectories: string[] = [];

function setAllowedDirectories(dirs: readonly string[]): void {
  const normalized = dirs
    .map(normalizeAllowedDirectory)
    .filter((dir) => dir.length > 0);
  allowedDirectories = [...new Set(normalized)];
}

export function getAllowedDirectories(): string[] {
  return [...allowedDirectories];
}

export function isPathWithinDirectories(
  normalizedPath: string,
  allowedDirs: readonly string[]
): boolean {
  const candidate = normalizeForComparison(normalizedPath);
  return allowedDirs.some((allowedDir) =>
    isPathWithinRoot(normalizeForComparison(allowedDir), candidate)
  );
}

async function expandAllowedDirectories(
  dirs: readonly string[]
): Promise<string[]> {
  const expanded: string[] = [];

  for (const dir of dirs) {
    const normalized = normalizeAllowedDirectory(dir);
    if (!normalized) continue;
    expanded.push(normalized);

    const normalizedReal = await resolveRealPath(normalized);
    if (
      normalizedReal &&
      normalizeForComparison(normalizedReal) !==
        normalizeForComparison(normalized)
    ) {
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

export async function setAllowedDirectoriesResolved(
  dirs: readonly string[]
): Promise<void> {
  const expanded = await expandAllowedDirectories(dirs);
  setAllowedDirectories(expanded);
}
