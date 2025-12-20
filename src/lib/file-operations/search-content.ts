import type { SearchContentResult } from '../../config/types.js';
import { SearchEngine } from './search/engine.js';

export async function searchContent(
  basePath: string,
  searchPattern: string,
  options: {
    filePattern?: string;
    excludePatterns?: string[];
    caseSensitive?: boolean;
    maxResults?: number;
    maxFileSize?: number;
    maxFilesScanned?: number;
    timeoutMs?: number;
    skipBinary?: boolean;
    contextLines?: number;
    wholeWord?: boolean;
    isLiteral?: boolean;
    includeHidden?: boolean;
    baseNameMatch?: boolean;
    caseSensitiveFileMatch?: boolean;
  } = {}
): Promise<SearchContentResult> {
  const engine = new SearchEngine(basePath, options);
  return engine.search(searchPattern);
}
