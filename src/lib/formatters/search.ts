import type { SearchResult } from '../../config/types.js';
import { formatBytes } from './bytes.js';

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
