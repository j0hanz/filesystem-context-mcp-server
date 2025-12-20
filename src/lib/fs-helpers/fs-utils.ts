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
  if (
    stream &&
    typeof stream === 'object' &&
    'destroy' in stream &&
    typeof (stream as { destroy: unknown }).destroy === 'function'
  ) {
    try {
      (stream as { destroy: () => void }).destroy();
    } catch {
      // Ignore errors during destruction
    }
  }
}
