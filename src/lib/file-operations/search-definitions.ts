import type {
  DefinitionMatch,
  SearchDefinitionsOptions,
  SearchDefinitionsResult,
} from '../../config/types.js';
import { ErrorCode, McpError } from '../errors.js';
import { validateExistingDirectory } from '../path-validation.js';
import { processMatches } from './search-definitions/matchers.js';
import {
  buildCombinedPattern,
  buildSearchOptions,
  getMaxResults,
} from './search-definitions/patterns.js';
import { executeSearch } from './search/engine.js';

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
