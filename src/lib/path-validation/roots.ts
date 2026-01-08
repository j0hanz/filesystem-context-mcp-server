import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Root } from '@modelcontextprotocol/sdk/types.js';

import { assertNotAborted, withAbort } from '../fs-helpers/abort.js';
import { normalizePath } from '../path-utils.js';
import { normalizeForComparison } from './allowed-directories.js';

function isFileRoot(root: Root): boolean {
  return root.uri.startsWith('file://');
}

async function maybeAddRealPath(
  normalizedPath: string,
  validDirs: string[],
  signal?: AbortSignal
): Promise<void> {
  try {
    assertNotAborted(signal);
    const realPath = await withAbort(fs.realpath(normalizedPath), signal);
    const normalizedReal = normalizePath(realPath);
    if (
      normalizeForComparison(normalizedReal) !==
      normalizeForComparison(normalizedPath)
    ) {
      validDirs.push(normalizedReal);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    // ignore
  }
}

async function resolveRootDirectory(
  root: Root,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const dirPath = fileURLToPath(root.uri);
    const normalizedPath = normalizePath(dirPath);
    assertNotAborted(signal);
    const stats = await withAbort(fs.stat(normalizedPath), signal);
    if (!stats.isDirectory()) return null;
    return normalizedPath;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    return null;
  }
}

export async function getValidRootDirectories(
  roots: Root[],
  signal?: AbortSignal
): Promise<string[]> {
  const validDirs: string[] = [];

  for (const root of roots) {
    if (!isFileRoot(root)) continue;

    const normalizedPath = await resolveRootDirectory(root, signal);
    if (!normalizedPath) continue;

    validDirs.push(normalizedPath);
    await maybeAddRealPath(normalizedPath, validDirs, signal);
  }

  return validDirs;
}
