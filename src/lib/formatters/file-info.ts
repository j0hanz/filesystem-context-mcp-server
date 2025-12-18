import type { FileInfo } from '../../config/types.js';
import { formatBytes } from './bytes.js';
import { formatDate } from './date.js';

export function formatFileInfo(info: FileInfo): string {
  const lines = [
    `Name: ${info.name}`,
    `Path: ${info.path}`,
    `Type: ${info.type}`,
    `Size: ${formatBytes(info.size)}`,
    `Created: ${formatDate(info.created)}`,
    `Modified: ${formatDate(info.modified)}`,
    `Accessed: ${formatDate(info.accessed)}`,
    `Permissions: ${info.permissions}`,
    `Hidden: ${info.isHidden ? 'Yes' : 'No'}`,
  ];

  if (info.mimeType) {
    lines.push(`MIME Type: ${info.mimeType}`);
  }

  if (info.symlinkTarget) {
    lines.push(`Symlink Target: ${info.symlinkTarget}`);
  }

  return lines.join('\n');
}
