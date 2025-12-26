import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import type { SearchDefinitionsResult } from '../config/types.js';
import { ErrorCode } from '../lib/errors.js';
import { searchDefinitions } from '../lib/file-operations.js';
import {
  SearchDefinitionsInputSchema,
  SearchDefinitionsOutputSchema,
} from '../schemas/index.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
} from './tool-response.js';

type SearchDefinitionsArgs = z.infer<
  z.ZodObject<typeof SearchDefinitionsInputSchema>
>;
type SearchDefinitionsStructuredResult = z.infer<
  typeof SearchDefinitionsOutputSchema
>;

function buildCriteriaText(searchName?: string, searchType?: string): string {
  const parts = [
    searchName ? `name "${searchName}"` : null,
    searchType ? `type "${searchType}"` : null,
  ].filter(Boolean);
  return parts.join(' and ');
}

function buildSearchLabel(searchName?: string, searchType?: string): string {
  const parts = [
    searchName ? `"${searchName}"` : null,
    searchType ? `(${searchType})` : null,
  ].filter(Boolean);
  return parts.join(' ');
}

function formatContextLines(lines?: string[]): string[] {
  return (lines ?? []).map((line) => `    ${line}`);
}

function formatDefinitionBlock(
  def: SearchDefinitionsResult['definitions'][number]
): string[] {
  const exportMarker = def.exported ? ' | exported' : '';
  const lines: string[] = [
    `[${def.definitionType}] ${def.file}:${def.line}${exportMarker}`,
  ];

  lines.push(...formatContextLines(def.contextBefore));
  lines.push(`  > ${def.content}`);
  lines.push(...formatContextLines(def.contextAfter));
  lines.push('');

  return lines;
}

function formatNoResultsText(result: SearchDefinitionsResult): string {
  const { summary, searchName, searchType } = result;
  const criteria = buildCriteriaText(searchName, searchType);
  const scopeNote = `Scanned ${summary.filesScanned} file(s), matched ${summary.filesMatched}.`;
  const hint =
    !searchName && !searchType
      ? 'Provide name or type to narrow the search.'
      : 'Try adjusting name/type or excludePatterns to refine results.';
  return `No definitions found matching ${criteria || 'current criteria'}\n${scopeNote}\n${hint}`;
}

function buildHeaderLines(result: SearchDefinitionsResult): string[] {
  const { summary, searchName, searchType } = result;
  const searchLabel = buildSearchLabel(searchName, searchType);
  const header = `Found ${summary.totalDefinitions} definition(s)${
    searchLabel ? ` for ${searchLabel}` : ''
  }:`;
  return [header, ''];
}

/**
 * Format text output for search definitions results
 */
function formatTextResult(result: SearchDefinitionsResult): string {
  const { definitions, summary } = result;

  if (definitions.length === 0) {
    return formatNoResultsText(result);
  }

  const lines: string[] = [...buildHeaderLines(result)];

  for (const def of definitions) {
    lines.push(...formatDefinitionBlock(def));
  }

  if (summary.truncated) {
    lines.push(`(Results truncated - scanned ${summary.filesScanned} files)`);
  }

  lines.push(
    `Scanned ${summary.filesScanned} file(s), matched ${summary.filesMatched}.`
  );

  return lines.join('\n');
}

/**
 * Build structured result for search definitions
 */
function buildStructuredResult(
  result: SearchDefinitionsResult
): SearchDefinitionsStructuredResult {
  return {
    ok: true,
    basePath: result.basePath,
    searchName: result.searchName,
    searchType: result.searchType,
    definitions: result.definitions.map((d) => ({
      file: d.file,
      line: d.line,
      definitionType: d.definitionType,
      name: d.name,
      content: d.content,
      contextBefore: d.contextBefore,
      contextAfter: d.contextAfter,
      exported: d.exported,
    })),
    summary: {
      filesScanned: result.summary.filesScanned,
      filesMatched: result.summary.filesMatched,
      totalDefinitions: result.summary.totalDefinitions,
      truncated: result.summary.truncated,
    },
  };
}

async function handleSearchDefinitions(
  args: SearchDefinitionsArgs
): Promise<ToolResponse<SearchDefinitionsStructuredResult>> {
  const result = await searchDefinitions({
    path: args.path,
    name: args.name,
    type: args.type,
    caseSensitive: args.caseSensitive,
    maxResults: args.maxResults,
    excludePatterns: args.excludePatterns,
    includeHidden: args.includeHidden,
    contextLines: args.contextLines,
  });

  return buildToolResponse(
    formatTextResult(result),
    buildStructuredResult(result)
  );
}

const SEARCH_DEFINITIONS_TOOL = {
  title: 'Search Definitions',
  description:
    'Find code definitions (classes, functions, interfaces, types, enums, variables) by name or type. ' +
    'Supports TypeScript and JavaScript files. ' +
    'Use name to find a specific symbol, type to find all definitions of a kind, or both for precise matching. ' +
    'Returns file locations, definition types, export status, and surrounding context.',
  inputSchema: SearchDefinitionsInputSchema,
  outputSchema: SearchDefinitionsOutputSchema.shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

const SEARCH_DEFINITIONS_TOOL_DEPRECATED = {
  ...SEARCH_DEFINITIONS_TOOL,
  description: `${SEARCH_DEFINITIONS_TOOL.description} (Deprecated: use searchDefinitions.)`,
} as const;

export function registerSearchDefinitionsTool(server: McpServer): void {
  const handler = async (
    args: SearchDefinitionsArgs
  ): Promise<ToolResult<SearchDefinitionsStructuredResult>> => {
    try {
      return await handleSearchDefinitions(args);
    } catch (error: unknown) {
      return buildToolErrorResponse(error, ErrorCode.E_UNKNOWN, args.path);
    }
  };

  server.registerTool(
    'search_definitions',
    SEARCH_DEFINITIONS_TOOL_DEPRECATED,
    handler
  );
  server.registerTool('searchDefinitions', SEARCH_DEFINITIONS_TOOL, handler);
}
