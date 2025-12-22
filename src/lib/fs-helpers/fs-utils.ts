import type { Stats } from 'node:fs';

import type { FileType } from '../../config/types.js';

export function getFileType(stats: Stats): FileType {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symlink';
  return 'other';
}

export function isHidden(name: string): boolean {
  return name.startsWith('.');
}

export function safeDestroy(stream: unknown): void {
  const destroy = getDestroyFn(stream);
  if (!destroy) return;
  try {
    destroy();
  } catch {
    // Ignore errors during destruction
  }
}

function getDestroyFn(stream: unknown): (() => void) | undefined {
  if (!stream || typeof stream !== 'object') return undefined;
  const candidate = stream as { destroy?: () => void };
  if (typeof candidate.destroy !== 'function') return undefined;
  return candidate.destroy.bind(stream);
}
