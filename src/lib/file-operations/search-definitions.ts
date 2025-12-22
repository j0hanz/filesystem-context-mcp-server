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
  // Use simple keyword patterns that are safe for regex
  switch (type) {
    case 'class':
      return '\\bclass\\s+[A-Za-z_$]';
    case 'function':
      return '\\bfunction\\s+[A-Za-z_$]';
    case 'interface':
      return '\\binterface\\s+[A-Za-z_$]';
    case 'type':
      return '\\btype\\s+[A-Za-z_$]';
    case 'enum':
      return '\\benum\\s+[A-Za-z_$]';
    case 'variable':
      return '\\b(?:const|let|var)\\s+[A-Za-z_$]';
  }
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

/**
 * Get the primary keyword for a definition type
 */
function getKeywordForType(type: DefinitionType): string {
  switch (type) {
    case 'class':
      return 'class';
    case 'function':
      return 'function';
    case 'interface':
      return 'interface';
    case 'type':
      return 'type';
    case 'enum':
      return 'enum';
    case 'variable':
      return '(?:const|let|var)';
  }
}

/**
 * Classify a line of code to determine the definition type
 */
function classifyLine(content: string): DefinitionType {
  const trimmed = content.trim();

  if (/\bclass\s+/u.test(trimmed)) return 'class';
  if (/\binterface\s+/u.test(trimmed)) return 'interface';
  if (/\btype\s+\w+\s*=/u.test(trimmed)) return 'type';
  if (/\benum\s+/u.test(trimmed)) return 'enum';
  if (
    /\bfunction\s+/u.test(trimmed) ||
    /=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/u.test(trimmed)
  ) {
    return 'function';
  }
  return 'variable';
}

/**
 * Extract the definition name from a line of code
 */
function extractName(content: string, searchType?: DefinitionType): string {
  const trimmed = content.trim();

  // Try specific patterns based on type
  const patterns: [RegExp, DefinitionType[]][] = [
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

  for (const [pattern, types] of patterns) {
    if (searchType && !types.includes(searchType)) continue;
    const match = pattern.exec(trimmed);
    if (match?.[1]) return match[1];
  }

  return 'unknown';
}

/**
 * Check if a definition is exported
 */
function isExported(content: string): boolean {
  return /\bexport\b/u.test(content);
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
    const detectedType = classifyLine(match.content);
    const name = extractName(match.content, searchType);

    // Skip if we can't extract a name
    if (name === 'unknown') continue;

    // For function type, also accept arrow functions declared with const/let
    const effectiveType =
      searchType === 'function' &&
      detectedType === 'variable' &&
      /=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/u.test(match.content)
        ? 'function'
        : detectedType;

    // Filter by type if specified
    if (searchType && effectiveType !== searchType) continue;

    // Filter by name if specified
    if (searchName) {
      const nameMatches = caseSensitive
        ? name === searchName
        : name.toLowerCase() === searchName.toLowerCase();
      if (!nameMatches) continue;
    }

    results.push({
      file: pathModule.relative(basePath, match.file),
      line: match.line,
      definitionType: searchType ?? effectiveType,
      name,
      content: match.content,
      contextBefore: match.contextBefore,
      contextAfter: match.contextAfter,
      exported: isExported(match.content),
    });
  }

  return results;
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
  const pattern = buildPattern(options.name, options.type);

  // For function searches, also search for arrow functions
  const additionalPatterns: string[] = [];
  if (options.type === 'function' && options.name) {
    // Also search for arrow function declarations
    additionalPatterns.push(
      `\\b(?:const|let)\\s+${escapeRegex(options.name)}\\s*=`
    );
  }

  // Combine patterns if needed
  const combinedPattern =
    additionalPatterns.length > 0
      ? `${pattern}|${additionalPatterns.join('|')}`
      : pattern;

  const searchResult = await executeSearch(validPath, combinedPattern, {
    filePattern: TS_JS_FILE_PATTERN,
    caseSensitive: options.caseSensitive ?? true,
    maxResults: (options.maxResults ?? 100) * 3, // Get more results to filter
    excludePatterns: options.excludePatterns,
    contextLines: options.contextLines ?? 2,
    includeHidden: options.includeHidden ?? false,
    isLiteral: false,
    wholeWord: false,
  });

  // Process and filter matches
  const definitions = processMatches(
    searchResult.matches,
    validPath,
    options.name,
    options.type,
    options.caseSensitive ?? true
  );

  // Apply maxResults limit
  const limitedDefinitions = definitions.slice(0, options.maxResults ?? 100);
  const truncated =
    searchResult.summary.truncated ||
    definitions.length > (options.maxResults ?? 100);

  return {
    basePath: validPath,
    searchName: options.name,
    searchType: options.type,
    definitions: limitedDefinitions,
    summary: {
      filesScanned: searchResult.summary.filesScanned,
      filesMatched: searchResult.summary.filesMatched,
      totalDefinitions: limitedDefinitions.length,
      truncated,
    },
  };
}
