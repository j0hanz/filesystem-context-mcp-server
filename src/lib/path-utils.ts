import * as os from 'node:os';
import * as path from 'node:path';

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

export function normalizePath(p: string): string {
  const expanded = expandHome(p);
  const resolved = path.resolve(expanded);

  if (process.platform === 'win32' && /^[A-Z]:/.test(resolved)) {
    return resolved.charAt(0).toLowerCase() + resolved.slice(1);
  }

  return resolved;
}

function resolveWithinRoot(root: string, input: string): string | null {
  const resolved = path.resolve(root, input);
  const relative = path.relative(root, resolved);
  if (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  ) {
    return resolved;
  }
  return null;
}

export function isPathWithinRoot(root: string, candidate: string): boolean {
  return resolveWithinRoot(root, candidate) !== null;
}
