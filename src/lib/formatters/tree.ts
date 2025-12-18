import type { TreeEntry } from '../../config/types.js';
import { formatBytes } from './bytes.js';

export function formatTreeEntry(entry: TreeEntry, indent = ''): string {
  const lines: string[] = [];
  const icon = entry.type === 'directory' ? '[DIR]' : '[FILE]';
  const sizeStr =
    entry.size !== undefined ? ` (${formatBytes(entry.size)})` : '';
  lines.push(`${indent}${icon} ${entry.name}${sizeStr}`);

  for (const child of entry.children ?? []) {
    lines.push(formatTreeEntry(child, `${indent}  `));
  }

  return lines.join('\n');
}
