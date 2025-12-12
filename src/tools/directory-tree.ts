import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createErrorResponse, ErrorCode } from '../lib/errors.js';
import { getDirectoryTree } from '../lib/file-operations.js';
import { formatTreeEntry } from '../lib/formatters.js';
import {
  DirectoryTreeInputSchema,
  DirectoryTreeOutputSchema,
} from '../schemas/index.js';

export function registerDirectoryTreeTool(server: McpServer): void {
  server.registerTool(
    'directory_tree',
    {
      title: 'Directory Tree',
      description:
        'Generate a hierarchical JSON tree structure of a directory. ' +
        'More efficient for AI parsing than flat file lists. ' +
        'Ideal for understanding project layout and structure at a glance. ' +
        'Use maxDepth to limit traversal depth and excludePatterns to skip folders like node_modules. ' +
        'Optionally include file sizes with includeSize=true.',
      inputSchema: DirectoryTreeInputSchema,
      outputSchema: DirectoryTreeOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      path,
      maxDepth,
      excludePatterns,
      includeHidden,
      includeSize,
      maxFiles,
    }) => {
      try {
        const result = await getDirectoryTree(path, {
          maxDepth,
          excludePatterns,
          includeHidden,
          includeSize,
          maxFiles,
        });

        let textOutput = formatTreeEntry(result.tree);

        const structured = {
          ok: true,
          tree: result.tree,
          summary: {
            totalFiles: result.summary.totalFiles,
            totalDirectories: result.summary.totalDirectories,
            maxDepthReached: result.summary.maxDepthReached,
            truncated: result.summary.truncated,
            skippedInaccessible: result.summary.skippedInaccessible,
            symlinksNotFollowed: result.summary.symlinksNotFollowed,
          },
        };

        // Add truncation notice for better error recovery feedback
        if (result.summary.truncated) {
          textOutput += `\n\n⚠️ PARTIAL RESULTS: tree was truncated`;
          textOutput +=
            '\nTip: Increase maxDepth or maxFiles, or add excludePatterns to narrow scope.';
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
