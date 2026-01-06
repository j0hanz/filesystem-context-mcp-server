import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Root } from '@modelcontextprotocol/sdk/types.js';

import { normalizePath } from '../path-utils.js';
import { normalizeForComparison } from './allowed-directories.js';

function isFileRoot(root: Root): boolean {
  return root.uri.startsWith('file://');
}

async function maybeAddRealPath(
  normalizedPath: string,
  validDirs: string[]
): Promise<void> {
  try {
    const realPath = await fs.realpath(normalizedPath);
    const normalizedReal = normalizePath(realPath);
    if (
      normalizeForComparison(normalizedReal) !==
      normalizeForComparison(normalizedPath)
    ) {
      validDirs.push(normalizedReal);
    }
  } catch {
    // ignore
  }
}

async function resolveRootDirectory(root: Root): Promise<string | null> {
  try {
    const dirPath = fileURLToPath(root.uri);
    const normalizedPath = normalizePath(dirPath);
    const stats = await fs.stat(normalizedPath);
    if (!stats.isDirectory()) return null;
    return normalizedPath;
  } catch {
    return null;
  }
}

export async function getValidRootDirectories(
  roots: Root[]
): Promise<string[]> {
  const validDirs: string[] = [];

  for (const root of roots) {
    if (!isFileRoot(root)) continue;

    const normalizedPath = await resolveRootDirectory(root);
    if (!normalizedPath) continue;

    validDirs.push(normalizedPath);
    await maybeAddRealPath(normalizedPath, validDirs);
  }

  return validDirs;
}
