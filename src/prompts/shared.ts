import { getAllowedDirectories } from '../lib/path-validation.js';

// Path autocompletion for prompt arguments
export function pathCompleter(value: string): string[] {
  const dirs = getAllowedDirectories();
  const lowerValue = value.toLowerCase();
  return dirs.filter(
    (d) =>
      d.toLowerCase().includes(lowerValue) ||
      lowerValue.includes(d.toLowerCase().slice(0, 10))
  );
}

// Common directories to exclude from filesystem operations
export const DEFAULT_EXCLUDES = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  'coverage/**',
] as const;
