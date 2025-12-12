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

// Extended exclude patterns for different use cases
export const EXTENDED_EXCLUDES = {
  minified: ['*.min.js'] as const,
  bundled: ['*.bundle.js'] as const,
  lockFiles: ['*.lock'] as const,
  nextjs: ['.next/**'] as const,
  nuxtjs: ['.nuxt/**'] as const,
} as const;

// Build exclude patterns by combining base with extensions
export function buildExcludes(
  ...extensions: (keyof typeof EXTENDED_EXCLUDES)[]
): string[] {
  return [
    ...DEFAULT_EXCLUDES,
    ...extensions.flatMap((ext) => [...EXTENDED_EXCLUDES[ext]]),
  ];
}
