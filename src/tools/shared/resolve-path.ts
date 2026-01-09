import { getAllowedDirectories } from '../../lib/path-validation/allowed-directories.js';

export function resolvePathOrRoot(path: string | undefined): string {
  if (path && path.trim().length > 0) return path;
  const firstRoot = getAllowedDirectories()[0];
  if (!firstRoot) {
    throw new Error('No workspace roots configured. Use roots to check.');
  }
  return firstRoot;
}
