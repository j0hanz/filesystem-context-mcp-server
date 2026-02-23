import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import ignore, { type Ignore } from 'ignore';

import { isNodeError } from '../errors.js';
import { toPosixPath } from '../path-format.js';

function parseGitignoreLines(contents: string): string[] {
  const lines: string[] = [];
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      lines.push(trimmed);
    }
  }
  return lines;
}

export async function loadRootGitignore(
  root: string,
  signal?: AbortSignal
): Promise<Ignore | null> {
  const gitignorePath = path.join(root, '.gitignore');

  let contents: string;
  try {
    contents = await fs.readFile(gitignorePath, {
      encoding: 'utf-8',
      signal,
    });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  const matcher = ignore();
  matcher.add(parseGitignoreLines(contents));

  return matcher;
}

export function isIgnoredByGitignore(
  matcher: Ignore,
  root: string,
  absolutePath: string,
  options: { isDirectory?: boolean; relativePath?: string } = {}
): boolean {
  let relative = options.relativePath;
  relative ??= path.relative(root, absolutePath);
  if (relative.length === 0) return false;

  const normalized = toPosixPath(relative);
  if (options.isDirectory) {
    return matcher.ignores(
      normalized.endsWith('/') ? normalized : `${normalized}/`
    );
  }
  return matcher.ignores(normalized);
}
