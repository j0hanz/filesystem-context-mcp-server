import * as os from 'node:os';
import * as path from 'node:path';

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

// Normalize path to canonical absolute form
export function normalizePath(p: string): string {
  const expanded = expandHome(p);
  const resolved = path.resolve(expanded);

  // On Windows, normalize drive letter to lowercase (C: -> c:)
  if (process.platform === 'win32' && /^[A-Z]:/.test(resolved)) {
    return resolved.charAt(0).toLowerCase() + resolved.slice(1);
  }

  return resolved;
}
