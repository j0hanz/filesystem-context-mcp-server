import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createErrorResponse, ErrorCode } from '../lib/errors.js';
import { listDirectory } from '../lib/file-operations.js';
import { formatDirectoryListing } from '../lib/formatters.js';
import {
  ListDirectoryInputSchema,
  ListDirectoryOutputSchema,
} from '../schemas/index.js';

export function registerListDirectoryTool(server: McpServer): void {
  server.registerTool(
    'list_directory',
    {
      title: 'List Directory',
      description:
        'List files and subdirectories in a specified path with optional recursive traversal. ' +
        'Returns names, types (file/directory/symlink), sizes, and modification dates. ' +
        'Use recursive=true with maxDepth to explore nested structures. ' +
        'For a visual tree structure, use directory_tree instead.',
      inputSchema: ListDirectoryInputSchema,
      outputSchema: ListDirectoryOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      path,
      recursive,
      includeHidden,
      maxDepth,
      maxEntries,
      sortBy,
      includeSymlinkTargets,
    }) => {
      try {
        const result = await listDirectory(path, {
          recursive,
          includeHidden,
          maxDepth,
          maxEntries,
          sortBy,
          includeSymlinkTargets,
        });
        const structured = {
          ok: true,
          path: result.path,
          entries: result.entries.map((e) => ({
            name: e.relativePath,
            type: e.type,
            size: e.size,
            modified: e.modified?.toISOString(),
            symlinkTarget: e.symlinkTarget,
          })),
          summary: {
            totalEntries: result.summary.totalEntries,
            totalFiles: result.summary.totalFiles,
            totalDirectories: result.summary.totalDirectories,
            maxDepthReached: result.summary.maxDepthReached,
            truncated: result.summary.truncated,
            skippedInaccessible: result.summary.skippedInaccessible,
            symlinksNotFollowed: result.summary.symlinksNotFollowed,
          },
        };

        // Build text output with truncation notice for better error recovery feedback
        let textOutput = formatDirectoryListing(result.entries, result.path);

        if (result.summary.truncated) {
          textOutput += `\n\n⚠️ PARTIAL RESULTS: reached max entries limit (${result.summary.totalEntries} returned)`;
          textOutput +=
            '\nTip: Increase maxEntries or reduce maxDepth to see more results.';
        }
        if (result.summary.skippedInaccessible > 0) {
          textOutput += `\nNote: ${result.summary.skippedInaccessible} item(s) were inaccessible and skipped.`;
        }
        if (result.summary.symlinksNotFollowed > 0) {
          textOutput += `\nNote: ${result.summary.symlinksNotFollowed} symlink(s) were not followed (security).`;
        }

        return {
          content: [{ type: 'text', text: textOutput }],
          structuredContent: structured,
        };
      } catch (error) {
        return createErrorResponse(error, ErrorCode.E_NOT_DIRECTORY, path);
      }
    }
  );
}
