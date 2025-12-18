import type { DirectoryEntry } from '../../config/types.js';
import { formatBytes } from './bytes.js';

export function formatDirectoryListing(
  entries: DirectoryEntry[],
  basePath: string
): string {
  if (entries.length === 0) {
    return 'Directory is empty';
  }

  const lines = [`Contents of ${basePath}:`, ''];

  const dirs = entries.filter((e) => e.type === 'directory');
  const files = entries.filter((e) => e.type !== 'directory');

  if (dirs.length > 0) {
    lines.push('Directories:');
    for (const dir of dirs) {
      const symlinkSuffix = dir.symlinkTarget ? ` -> ${dir.symlinkTarget}` : '';
      lines.push(`  [DIR]  ${dir.relativePath}${symlinkSuffix}`);
    }
    lines.push('');
  }

  if (files.length > 0) {
    lines.push('Files:');
    for (const file of files) {
      const size = file.size !== undefined ? formatBytes(file.size) : undefined;
      const sizeSuffix = size !== undefined ? ` (${size})` : '';
      const typeTag = file.type === 'symlink' ? '[LINK]' : '[FILE]';
      const symlinkSuffix = file.symlinkTarget
        ? ` -> ${file.symlinkTarget}`
        : '';
      lines.push(
        `  ${typeTag} ${file.relativePath}${sizeSuffix}${symlinkSuffix}`
      );
    }
  }

  lines.push('');
  lines.push(`Total: ${dirs.length} directories, ${files.length} files`);

  return lines.join('\n');
}
