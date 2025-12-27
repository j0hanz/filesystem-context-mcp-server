import * as pathModule from 'node:path';

import type { DefinitionMatch, DefinitionType } from '../../../config/types.js';

const ARROW_FUNCTION_REGEX = /=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/u;

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

function isArrowFunction(content: string): boolean {
  return ARROW_FUNCTION_REGEX.test(content);
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

function getExtractorCandidates(
  searchType?: DefinitionType
): readonly [RegExp, readonly DefinitionType[]][] {
  if (!searchType) return NAME_EXTRACTORS;
  return NAME_EXTRACTORS.filter(([, types]) => types.includes(searchType));
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
export function processMatches(
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
