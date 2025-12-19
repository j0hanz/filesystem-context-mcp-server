import * as pathModule from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createErrorResponse, ErrorCode } from '../lib/errors.js';
import { listDirectory } from '../lib/file-operations.js';
import {
  formatDirectoryListing,
  formatOperationSummary,
} from '../lib/formatters.js';
import {
  ListDirectoryInputSchema,
  ListDirectoryOutputSchema,
} from '../schemas/index.js';

function getExtension(name: string, isFile: boolean): string | undefined {
  if (!isFile) return undefined;
  const ext = pathModule.extname(name);
  return ext ? ext.slice(1) : undefined;
}

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
      path: dirPath,
      recursive,
      includeHidden,
      maxDepth,
      maxEntries,
      sortBy,
      includeSymlinkTargets,
    }) => {
      try {
        const result = await listDirectory(dirPath, {
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
            extension: getExtension(e.relativePath, e.type === 'file'),
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
        textOutput += formatOperationSummary({
          truncated: result.summary.truncated,
          truncatedReason: `reached max entries limit (${result.summary.totalEntries} returned)`,
          tip: 'Increase maxEntries or reduce maxDepth to see more results.',
          skippedInaccessible: result.summary.skippedInaccessible,
          symlinksNotFollowed: result.summary.symlinksNotFollowed,
        });

        return {
          content: [{ type: 'text', text: textOutput }],
          structuredContent: structured,
        };
      } catch (error) {
        return createErrorResponse(error, ErrorCode.E_NOT_DIRECTORY, dirPath);
      }
    }
  );
}
