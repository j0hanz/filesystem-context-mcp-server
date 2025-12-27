import type {
  DefinitionType,
  SearchDefinitionsOptions,
} from '../../../config/types.js';

/**
 * TypeScript/JavaScript file extensions for definition search
 */
const TS_JS_FILE_PATTERN = '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}';

const SIMPLE_TYPE_PATTERNS: Readonly<Record<DefinitionType, string>> = {
  class: '\\bclass\\s+[A-Za-z_$]',
  function: '\\bfunction\\s+[A-Za-z_$]',
  interface: '\\binterface\\s+[A-Za-z_$]',
  type: '\\btype\\s+[A-Za-z_$]',
  enum: '\\benum\\s+[A-Za-z_$]',
  variable: '\\b(?:const|let|var)\\s+[A-Za-z_$]',
} as const;

const KEYWORD_BY_TYPE: Readonly<Record<DefinitionType, string>> = {
  class: 'class',
  function: 'function',
  interface: 'interface',
  type: 'type',
  enum: 'enum',
  variable: '(?:const|let|var)',
} as const;

/**
 * Escape special regex characters in a string
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Get simplified search patterns for definition types.
 * These patterns are safe for regex engines and we filter results post-search.
 */
function getSimpleTypePattern(type: DefinitionType): string {
  return SIMPLE_TYPE_PATTERNS[type];
}

/**
 * Get the primary keyword for a definition type
 */
function getKeywordForType(type: DefinitionType): string {
  return KEYWORD_BY_TYPE[type];
}

/**
 * Build a safe search pattern based on name and/or type
 */
function buildPattern(name?: string, type?: DefinitionType): string {
  if (name && type) {
    const keyword = getKeywordForType(type);
    return `\\b${keyword}\\s+${escapeRegex(name)}\\b`;
  }

  if (name) {
    return `\\b(?:class|interface|type|function|enum|const|let|var)\\s+${escapeRegex(name)}\\b`;
  }

  if (type) {
    return getSimpleTypePattern(type);
  }

  return '\\b(?:class|interface|type|function|enum|const|let|var)\\s+[A-Za-z_$]';
}

export function getMaxResults(options: SearchDefinitionsOptions): number {
  return options.maxResults ?? 100;
}

function buildAdditionalPatterns(options: SearchDefinitionsOptions): string[] {
  if (options.type !== 'function' || !options.name) return [];
  return [`\\b(?:const|let)\\s+${escapeRegex(options.name)}\\s*=`];
}

export function buildCombinedPattern(
  options: SearchDefinitionsOptions
): string {
  const pattern = buildPattern(options.name, options.type);
  const additional = buildAdditionalPatterns(options);
  if (additional.length === 0) return pattern;
  return `${pattern}|${additional.join('|')}`;
}

export function buildSearchOptions(
  options: SearchDefinitionsOptions,
  maxResults: number
): {
  filePattern: string;
  caseSensitive: boolean;
  maxResults: number;
  excludePatterns?: string[];
  contextLines: number;
  includeHidden: boolean;
  isLiteral: false;
  wholeWord: false;
} {
  return {
    filePattern: TS_JS_FILE_PATTERN,
    caseSensitive: options.caseSensitive ?? true,
    maxResults: maxResults * 3,
    excludePatterns: options.excludePatterns,
    contextLines: options.contextLines ?? 2,
    includeHidden: options.includeHidden ?? false,
    isLiteral: false,
    wholeWord: false,
  };
}
