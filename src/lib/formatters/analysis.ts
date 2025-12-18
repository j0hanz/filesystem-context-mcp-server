import type { DirectoryAnalysis } from '../../config/types.js';
import { formatBytes } from './bytes.js';
import { formatDate } from './date.js';

const ANALYSIS_SEPARATOR_WIDTH = 50;

export function formatDirectoryAnalysis(analysis: DirectoryAnalysis): string {
  const lines = [
    `Directory Analysis: ${analysis.path}`,
    '='.repeat(ANALYSIS_SEPARATOR_WIDTH),
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
