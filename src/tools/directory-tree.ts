import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createErrorResponse, ErrorCode } from '../lib/errors.js';
import { getDirectoryTree } from '../lib/file-operations.js';
import { formatOperationSummary, formatTreeEntry } from '../lib/formatters.js';
import {
  DirectoryTreeInputSchema,
  DirectoryTreeOutputSchema,
} from '../schemas/index.js';
import { buildTraversalSummary } from './shared/summary.js';

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
          summary: buildTraversalSummary(result.summary),
        };

        // Add truncation notice for better error recovery feedback
        textOutput += formatOperationSummary({
          truncated: result.summary.truncated,
          truncatedReason: 'tree was truncated',
          tip: 'Increase maxDepth or maxFiles, or add excludePatterns to narrow scope.',
          skippedInaccessible: result.summary.skippedInaccessible,
          symlinksNotFollowed: result.summary.symlinksNotFollowed,
        });

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
