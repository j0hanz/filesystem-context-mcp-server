import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createErrorResponse, ErrorCode } from '../lib/errors.js';
import { searchFiles } from '../lib/file-operations.js';
import { formatSearchResults } from '../lib/formatters.js';
import {
  SearchFilesInputSchema,
  SearchFilesOutputSchema,
} from '../schemas/index.js';

export function registerSearchFilesTool(server: McpServer): void {
  server.registerTool(
    'search_files',
    {
      title: 'Search Files',
      description:
        'Find files matching a glob pattern within a directory tree. ' +
        'Pattern examples: "**/*.ts" (all TypeScript files), "src/**/*.{js,jsx}" (JS/JSX in src), ' +
        '"**/test/**" (all test directories). Returns paths, types, sizes, and modification dates. ' +
        'Use excludePatterns to skip directories like node_modules.',
      inputSchema: SearchFilesInputSchema,
      outputSchema: SearchFilesOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      path: basePath,
      pattern,
      excludePatterns,
      maxResults,
      sortBy,
      maxDepth,
    }) => {
      try {
        const result = await searchFiles(basePath, pattern, excludePatterns, {
          maxResults,
          sortBy,
          maxDepth,
        });
        const structured = {
          ok: true,
          basePath: result.basePath,
          pattern: result.pattern,
          results: result.results.map((r) => ({
            path: path.relative(result.basePath, r.path),
            type: r.type,
            size: r.size,
            modified: r.modified?.toISOString(),
          })),
          summary: {
            matched: result.summary.matched,
            truncated: result.summary.truncated,
            skippedInaccessible: result.summary.skippedInaccessible,
          },
        };

        // Build text output with truncation notice for better error recovery feedback
        let textOutput = formatSearchResults(result.results);

        if (result.summary.truncated) {
          textOutput += `\n\n⚠️ PARTIAL RESULTS: reached max results limit (${result.summary.matched} returned)`;
          if (result.summary.skippedInaccessible > 0) {
            textOutput += `; ${result.summary.skippedInaccessible} file(s) skipped (inaccessible)`;
          }
          textOutput +=
            '\nTip: Increase maxResults, use more specific pattern, or add excludePatterns to narrow scope.';
        } else if (result.summary.skippedInaccessible > 0) {
          textOutput += `\n\nNote: ${result.summary.skippedInaccessible} file(s) were inaccessible and skipped.`;
        }

        return {
          content: [{ type: 'text', text: textOutput }],
          structuredContent: structured,
        };
      } catch (error) {
        return createErrorResponse(
          error,
          ErrorCode.E_INVALID_PATTERN,
          basePath
        );
      }
    }
  );
}
