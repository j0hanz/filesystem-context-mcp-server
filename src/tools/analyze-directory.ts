import * as nodePath from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createErrorResponse, ErrorCode } from '../lib/errors.js';
import { analyzeDirectory } from '../lib/file-operations.js';
import { formatDirectoryAnalysis } from '../lib/formatters.js';
import {
  AnalyzeDirectoryInputSchema,
  AnalyzeDirectoryOutputSchema,
} from '../schemas/index.js';

export function registerAnalyzeDirectoryTool(server: McpServer): void {
  server.registerTool(
    'analyze_directory',
    {
      title: 'Analyze Directory',
      description:
        'Gather statistics about a directory: total files/directories, total size, ' +
        'file type distribution by extension, largest files (topN), and most recently modified files. ' +
        'Useful for understanding project structure and identifying large files. ' +
        'Use excludePatterns to skip directories like node_modules.',
      inputSchema: AnalyzeDirectoryInputSchema,
      outputSchema: AnalyzeDirectoryOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ path, maxDepth, topN, excludePatterns, includeHidden }) => {
      try {
        const result = await analyzeDirectory(path, {
          maxDepth,
          topN,
          excludePatterns,
          includeHidden,
        });
        const structured = {
          ok: true,
          path: result.analysis.path,
          totalFiles: result.analysis.totalFiles,
          totalDirectories: result.analysis.totalDirectories,
          totalSize: result.analysis.totalSize,
          fileTypes: result.analysis.fileTypes,
          largestFiles: result.analysis.largestFiles.map((f) => ({
            path: nodePath.relative(result.analysis.path, f.path),
            size: f.size,
          })),
          recentlyModified: result.analysis.recentlyModified.map((f) => ({
            path: nodePath.relative(result.analysis.path, f.path),
            modified: f.modified.toISOString(),
          })),
          summary: {
            truncated: result.summary.truncated,
            skippedInaccessible: result.summary.skippedInaccessible,
            symlinksNotFollowed: result.summary.symlinksNotFollowed,
          },
        };

        // Build text output with error recovery feedback
        let textOutput = formatDirectoryAnalysis(result.analysis);

        if (result.summary.skippedInaccessible > 0) {
          textOutput += `\n\nNote: ${result.summary.skippedInaccessible} item(s) were inaccessible and skipped.`;
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
