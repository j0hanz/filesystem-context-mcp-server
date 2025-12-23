import * as pathModule from 'node:path';

import type {
  DefinitionMatch,
  DefinitionType,
  SearchDefinitionsOptions,
  SearchDefinitionsResult,
} from '../../config/types.js';
import { ErrorCode, McpError } from '../errors.js';
import { validateExistingDirectory } from '../path-validation.js';
import { executeSearch } from './search/engine.js';

/**
 * TypeScript/JavaScript file extensions for definition search
 */
const TS_JS_FILE_PATTERN = '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}';
const ARROW_FUNCTION_REGEX = /=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/u;
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

const LINE_TYPE_PATTERNS: readonly [RegExp, DefinitionType][] = [
  [/\bclass\s+/u, 'class'],
  [/\binterface\s+/u, 'interface'],
  [/\btype\s+\w+\s*=/u, 'type'],
  [/\benum\s+/u, 'enum'],
  [/\bfunction\s+/u, 'function'],
  [ARROW_FUNCTION_REGEX, 'function'],
];

const NAME_EXTRACTORS: readonly [RegExp, readonly DefinitionType[]][] = [
  [/\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)/u, ['class']],
  [/\binterface\s+([A-Za-z_$][A-Za-z0-9_$]*)/u, ['interface']],
  [/\btype\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/u, ['type']],
  [/\benum\s+([A-Za-z_$][A-Za-z0-9_$]*)/u, ['enum']],
  [/\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)/u, ['function']],
  [
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/u,
    ['variable', 'function'],
  ],
];

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Get simplified search patterns for definition types.
 * These patterns are safe for regex engines and we filter results post-search.
 */
function getSimpleTypePattern(type: DefinitionType): string {
  return SIMPLE_TYPE_PATTERNS[type];
}

/**
 * Build a safe search pattern based on name and/or type
 */
function buildPattern(name?: string, type?: DefinitionType): string {
  if (name && type) {
    // Search for specific name with type hint - use simple keyword + name
    const keyword = getKeywordForType(type);
    return `\\b${keyword}\\s+${escapeRegex(name)}\\b`;
  }

  if (name) {
    // Search for any definition with this name - simple approach
    return `\\b(?:class|interface|type|function|enum|const|let|var)\\s+${escapeRegex(name)}\\b`;
  }

  // Discovery mode: find all definitions of the given type
  if (type) {
    return getSimpleTypePattern(type);
  }

  // Fallback
  return '\\b(?:class|interface|type|function|enum|const|let|var)\\s+[A-Za-z_$]';
}

function getMaxResults(options: SearchDefinitionsOptions): number {
  return options.maxResults ?? 100;
}

function isArrowFunction(content: string): boolean {
  return ARROW_FUNCTION_REGEX.test(content);
}

/**
 * Get the primary keyword for a definition type
 */
function getKeywordForType(type: DefinitionType): string {
  return KEYWORD_BY_TYPE[type];
}

function resolveEffectiveType(
  detectedType: DefinitionType,
  searchType: DefinitionType | undefined,
  content: string
): DefinitionType {
  if (searchType !== 'function') return detectedType;
  if (detectedType !== 'variable') return detectedType;
  return isArrowFunction(content) ? 'function' : detectedType;
}

function isNameMatch(
  name: string,
  searchName: string | undefined,
  caseSensitive: boolean
): boolean {
  if (!searchName) return true;
  return caseSensitive
    ? name === searchName
    : name.toLowerCase() === searchName.toLowerCase();
}

function isTypeMatch(
  searchType: DefinitionType | undefined,
  effectiveType: DefinitionType
): boolean {
  if (!searchType) return true;
  return effectiveType === searchType;
}

/**
 * Classify a line of code to determine the definition type
 */
function classifyLine(content: string): DefinitionType {
  const trimmed = content.trim();
  for (const [pattern, type] of LINE_TYPE_PATTERNS) {
    if (pattern.test(trimmed)) return type;
  }
  return 'variable';
}

/**
 * Extract the definition name from a line of code
 */
function extractName(content: string, searchType?: DefinitionType): string {
  const trimmed = content.trim();
  const candidates = getExtractorCandidates(searchType);
  for (const [pattern] of candidates) {
    const match = pattern.exec(trimmed);
    if (match?.[1]) return match[1];
  }
  return 'unknown';
}

function getExtractorCandidates(
  searchType?: DefinitionType
): readonly [RegExp, readonly DefinitionType[]][] {
  if (!searchType) return NAME_EXTRACTORS;
  return NAME_EXTRACTORS.filter(([, types]) => types.includes(searchType));
}

/**
 * Check if a definition is exported
 */
function isExported(content: string): boolean {
  return /\bexport\b/u.test(content);
}

function resolveDefinitionMeta(
  content: string,
  searchName?: string,
  searchType?: DefinitionType,
  caseSensitive = true
): { name: string; effectiveType: DefinitionType; exported: boolean } | null {
  const detectedType = classifyLine(content);
  const name = extractName(content, searchType);
  if (name === 'unknown') return null;

  const effectiveType = resolveEffectiveType(detectedType, searchType, content);

  if (!isTypeMatch(searchType, effectiveType)) return null;
  if (!isNameMatch(name, searchName, caseSensitive)) return null;

  return {
    name,
    effectiveType,
    exported: isExported(content),
  };
}

function buildDefinitionMatch(
  match: {
    file: string;
    line: number;
    content: string;
    contextBefore?: string[];
    contextAfter?: string[];
  },
  basePath: string,
  searchName?: string,
  searchType?: DefinitionType,
  caseSensitive = true
): DefinitionMatch | null {
  const meta = resolveDefinitionMeta(
    match.content,
    searchName,
    searchType,
    caseSensitive
  );
  if (!meta) return null;

  return {
    file: pathModule.relative(basePath, match.file),
    line: match.line,
    definitionType: searchType ?? meta.effectiveType,
    name: meta.name,
    content: match.content,
    contextBefore: match.contextBefore,
    contextAfter: match.contextAfter,
    exported: meta.exported,
  };
}

/**
 * Filter and classify matches into definition results
 */
function processMatches(
  matches: {
    file: string;
    line: number;
    content: string;
    contextBefore?: string[];
    contextAfter?: string[];
  }[],
  basePath: string,
  searchName?: string,
  searchType?: DefinitionType,
  caseSensitive?: boolean
): DefinitionMatch[] {
  const results: DefinitionMatch[] = [];

  for (const match of matches) {
    const result = buildDefinitionMatch(
      match,
      basePath,
      searchName,
      searchType,
      caseSensitive ?? true
    );
    if (result) results.push(result);
  }

  return results;
}

function buildAdditionalPatterns(options: SearchDefinitionsOptions): string[] {
  if (options.type !== 'function' || !options.name) return [];
  return [`\\b(?:const|let)\\s+${escapeRegex(options.name)}\\s*=`];
}

function buildCombinedPattern(options: SearchDefinitionsOptions): string {
  const pattern = buildPattern(options.name, options.type);
  const additional = buildAdditionalPatterns(options);
  if (additional.length === 0) return pattern;
  return `${pattern}|${additional.join('|')}`;
}

function buildSearchOptions(
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

function buildSearchResult(
  validPath: string,
  options: SearchDefinitionsOptions,
  definitions: DefinitionMatch[],
  summary: { filesScanned: number; filesMatched: number; truncated: boolean },
  maxResults: number
): SearchDefinitionsResult {
  const limitedDefinitions = definitions.slice(0, maxResults);
  const truncated = summary.truncated || definitions.length > maxResults;

  return {
    basePath: validPath,
    searchName: options.name,
    searchType: options.type,
    definitions: limitedDefinitions,
    summary: {
      filesScanned: summary.filesScanned,
      filesMatched: summary.filesMatched,
      totalDefinitions: limitedDefinitions.length,
      truncated,
    },
  };
}

/**
 * Search for code definitions in TypeScript/JavaScript files
 */
export async function searchDefinitions(
  options: SearchDefinitionsOptions
): Promise<SearchDefinitionsResult> {
  // Validate input: must provide name OR type
  if (!options.name && !options.type) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Must provide either name or type (or both) to search for definitions',
      options.path
    );
  }

  const validPath = await validateExistingDirectory(options.path);
  const combinedPattern = buildCombinedPattern(options);
  const maxResults = getMaxResults(options);

  const searchResult = await executeSearch(
    validPath,
    combinedPattern,
    buildSearchOptions(options, maxResults)
  );

  // Process and filter matches
  const definitions = processMatches(
    searchResult.matches,
    validPath,
    options.name,
    options.type,
    options.caseSensitive ?? true
  );

  return buildSearchResult(
    validPath,
    options,
    definitions,
    {
      filesScanned: searchResult.summary.filesScanned,
      filesMatched: searchResult.summary.filesMatched,
      truncated: searchResult.summary.truncated,
    },
    maxResults
  );
}
