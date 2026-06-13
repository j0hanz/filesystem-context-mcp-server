export interface SearchOptions {
  pattern: string;
  path?: string;
  filePattern?: string;
  excludePatterns?: string[];
  caseSensitive?: boolean;
  wholeWord?: boolean;
  isLiteral?: boolean;
  maxResults?: number;
  maxFileSize?: number;
  maxFilesScanned?: number;
  timeoutMs?: number;
  skipBinary?: boolean;
  contextBefore?: number;
  contextAfter?: number;
  fileSearch?: boolean;
  includeStats?: boolean;
  signal?: AbortSignal;
  maxDepth?: number;
  baseNameMatch?: boolean;
  includeHidden?: boolean;
  respectGitignore?: boolean;
  fuzzy?: boolean;
}

export interface ContentMatch {
  readonly line: number;
  readonly content: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

export interface FileMatch {
  readonly filePath: string;
  readonly matches: readonly ContentMatch[];
  readonly size?: number;
  readonly modified?: Date;
}

export interface SearchResult {
  readonly filesMatched: readonly FileMatch[];
  readonly summary: {
    readonly filesScanned: number;
    readonly filesMatched: number;
    readonly matchesCount: number;
    readonly truncated: boolean;
  };
}
