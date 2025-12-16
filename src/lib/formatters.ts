import type {
  ContentMatch,
  DirectoryAnalysis,
  DirectoryEntry,
  FileInfo,
  SearchResult,
  TreeEntry,
} from '../config/types.js';

const BYTES_PER_KB = 1024;
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const SEPARATOR_LENGTH = 50;

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const unitIndex = Math.floor(Math.log(bytes) / Math.log(BYTES_PER_KB));
  const unit = BYTE_UNITS[unitIndex] ?? 'B';
  const value = bytes / Math.pow(BYTES_PER_KB, unitIndex);

  return `${parseFloat(value.toFixed(2))} ${unit}`;
}

function formatDate(date: Date): string {
  return date.toISOString();
}

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

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No matches found';
  }

  const lines = [`Found ${results.length} matches:`, ''];

  for (const result of results) {
    const typeTag = result.type === 'directory' ? '[DIR]' : '[FILE]';
    const size =
      result.size !== undefined ? ` (${formatBytes(result.size)})` : '';
    lines.push(`${typeTag} ${result.path}${size}`);
  }

  return lines.join('\n');
}

export function formatContentMatches(matches: ContentMatch[]): string {
  if (matches.length === 0) {
    return 'No matches found';
  }

  const lines = [`Found ${matches.length} matches:`, ''];

  const byFile = new Map<string, ContentMatch[]>();
  for (const match of matches) {
    const existing = byFile.get(match.file);
    if (existing) {
      existing.push(match);
    } else {
      byFile.set(match.file, [match]);
    }
  }

  for (const [file, fileMatches] of byFile) {
    lines.push(`${file}:`);
    for (const match of fileMatches) {
      // Show context before if available
      if (match.contextBefore && match.contextBefore.length > 0) {
        for (let i = 0; i < match.contextBefore.length; i++) {
          const contextLine = match.contextBefore[i];
          const lineNum = match.line - match.contextBefore.length + i;
          lines.push(
            `    ${String(lineNum).padStart(4)}: ${contextLine ?? ''}`
          );
        }
      }
      // Show the match line (highlighted)
      lines.push(`  > ${String(match.line).padStart(4)}: ${match.content}`);
      // Show context after if available
      if (match.contextAfter && match.contextAfter.length > 0) {
        for (let i = 0; i < match.contextAfter.length; i++) {
          const contextLine = match.contextAfter[i];
          const lineNum = match.line + 1 + i;
          lines.push(
            `    ${String(lineNum).padStart(4)}: ${contextLine ?? ''}`
          );
        }
      }
      // Add separator if there was context
      if (
        (match.contextBefore && match.contextBefore.length > 0) ||
        (match.contextAfter && match.contextAfter.length > 0)
      ) {
        lines.push('    ---');
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

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

export function formatDirectoryAnalysis(analysis: DirectoryAnalysis): string {
  const lines = [
    `Directory Analysis: ${analysis.path}`,
    '='.repeat(SEPARATOR_LENGTH),
    '',
    'Summary:',
    `  Total Files: ${analysis.totalFiles}`,
    `  Total Directories: ${analysis.totalDirectories}`,
    `  Total Size: ${formatBytes(analysis.totalSize)}`,
    `  Max Depth: ${analysis.maxDepth}`,
    '',
  ];

  if (Object.keys(analysis.fileTypes).length > 0) {
    lines.push('File Types:');
    const sorted = Object.entries(analysis.fileTypes).sort(
      (a, b) => b[1] - a[1]
    );

    for (const [ext, count] of sorted) {
      lines.push(`  ${ext}: ${count}`);
    }
    lines.push('');
  }

  if (analysis.largestFiles.length > 0) {
    lines.push('Largest Files:');
    for (const file of analysis.largestFiles) {
      lines.push(`  ${formatBytes(file.size)} - ${file.path}`);
    }
    lines.push('');
  }

  if (analysis.recentlyModified.length > 0) {
    lines.push('Recently Modified:');
    for (const file of analysis.recentlyModified) {
      lines.push(`  ${formatDate(file.modified)} - ${file.path}`);
    }
  }

  return lines.join('\n');
}

export function formatTreeEntry(entry: TreeEntry, indent = ''): string {
  const lines: string[] = [];
  const icon = entry.type === 'directory' ? '📁' : '📄';
  const sizeStr =
    entry.size !== undefined ? ` (${formatBytes(entry.size)})` : '';
  lines.push(`${indent}${icon} ${entry.name}${sizeStr}`);

  for (const child of entry.children ?? []) {
    lines.push(formatTreeEntry(child, `${indent}  `));
  }

  return lines.join('\n');
}

export function formatAllowedDirectories(dirs: string[]): string {
  if (dirs.length === 0) {
    return 'No directories are currently allowed.';
  }

  const lines = ['Allowed Directories:', ''];
  for (const dir of dirs) {
    lines.push(`  - ${dir}`);
  }

  return lines.join('\n');
}

// Common summary structure for operation results
interface OperationSummary {
  truncated?: boolean;
  truncatedReason?: string;
  tip?: string;
  skippedInaccessible?: number;
  symlinksNotFollowed?: number;
  skippedTooLarge?: number;
  skippedBinary?: number;
  linesSkippedDueToRegexTimeout?: number;
}

// Format operation summary messages (truncation, skipped items, symlinks)
export function formatOperationSummary(summary: OperationSummary): string {
  const lines: string[] = [];

  if (summary.truncated) {
    lines.push(
      `\n\n⚠️ PARTIAL RESULTS: ${summary.truncatedReason ?? 'results truncated'}`
    );
    if (summary.tip) {
      lines.push(`Tip: ${summary.tip}`);
    }
  }

  if (summary.skippedTooLarge && summary.skippedTooLarge > 0) {
    lines.push(`Note: ${summary.skippedTooLarge} file(s) skipped (too large).`);
  }

  if (summary.skippedBinary && summary.skippedBinary > 0) {
    lines.push(`Note: ${summary.skippedBinary} file(s) skipped (binary).`);
  }

  if (summary.skippedInaccessible && summary.skippedInaccessible > 0) {
    lines.push(
      `Note: ${summary.skippedInaccessible} item(s) were inaccessible and skipped.`
    );
  }

  if (summary.symlinksNotFollowed && summary.symlinksNotFollowed > 0) {
    lines.push(
      `Note: ${summary.symlinksNotFollowed} symlink(s) were not followed (security).`
    );
  }

  if (
    summary.linesSkippedDueToRegexTimeout &&
    summary.linesSkippedDueToRegexTimeout > 0
  ) {
    lines.push(
      `Note: ${summary.linesSkippedDueToRegexTimeout} line(s) skipped (regex timeout).`
    );
  }

  return lines.join('\n');
}
