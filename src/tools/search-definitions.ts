import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import type { SearchDefinitionsResult } from '../config/types.js';
import { ErrorCode, toRpcError } from '../lib/errors.js';
import { searchDefinitions } from '../lib/file-operations.js';
import {
  SearchDefinitionsInputSchema,
  SearchDefinitionsOutputSchema,
} from '../schemas/index.js';
import { buildToolResponse, type ToolResponse } from './tool-response.js';

type SearchDefinitionsArgs = z.infer<
  z.ZodObject<typeof SearchDefinitionsInputSchema>
>;
type SearchDefinitionsStructuredResult = z.infer<
  typeof SearchDefinitionsOutputSchema
>;

/**
 * Format text output for search definitions results
 */
function formatTextResult(result: SearchDefinitionsResult): string {
  const { definitions, summary, searchName, searchType } = result;

  if (definitions.length === 0) {
    const criteria = [
      searchName ? `name "${searchName}"` : null,
      searchType ? `type "${searchType}"` : null,
    ]
      .filter(Boolean)
      .join(' and ');
    return `No definitions found matching ${criteria}`;
  }

  const lines: string[] = [];
  const searchCriteria = [
    searchName ? `"${searchName}"` : null,
    searchType ? `(${searchType})` : null,
  ]
    .filter(Boolean)
    .join(' ');

  lines.push(
    `Found ${summary.totalDefinitions} definition(s)${searchCriteria ? ` for ${searchCriteria}` : ''}:`
  );
  lines.push('');

  for (const def of definitions) {
    const exportMarker = def.exported ? ' | exported' : '';
    lines.push(
      `[${def.definitionType}] ${def.file}:${def.line}${exportMarker}`
    );

    // Show context before
    if (def.contextBefore && def.contextBefore.length > 0) {
      for (const line of def.contextBefore) {
        lines.push(`    ${line}`);
      }
    }

    // Show the matching line
    lines.push(`  > ${def.content}`);

    // Show context after
    if (def.contextAfter && def.contextAfter.length > 0) {
      for (const line of def.contextAfter) {
        lines.push(`    ${line}`);
      }
    }

    lines.push('');
  }

  if (summary.truncated) {
    lines.push(`(Results truncated - scanned ${summary.filesScanned} files)`);
  }

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

export function registerSearchDefinitionsTool(server: McpServer): void {
  server.registerTool(
    'search_definitions',
    SEARCH_DEFINITIONS_TOOL,
    async (args: SearchDefinitionsArgs) => {
      try {
        return await handleSearchDefinitions(args);
      } catch (error: unknown) {
        throw toRpcError(error, ErrorCode.E_UNKNOWN, args.path);
      }
    }
  );
}
