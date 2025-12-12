import * as nodePath from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createErrorResponse, ErrorCode } from '../lib/errors.js';
import { searchContent } from '../lib/file-operations.js';
import { formatContentMatches } from '../lib/formatters.js';
import { logger } from '../lib/mcp-logger.js';
import {
  SearchContentInputSchema,
  SearchContentOutputSchema,
} from '../schemas/index.js';

export function registerSearchContentTool(server: McpServer): void {
  server.registerTool(
    'search_content',
    {
      title: 'Search Content',
      description:
        'Search for text patterns within file contents using regular expressions (grep-like). ' +
        'Returns matching lines with optional context (contextLines parameter). ' +
        'Use isLiteral=true for exact string matching, wholeWord=true to avoid partial matches. ' +
        'Filter files with filePattern glob (e.g., "**/*.ts" for TypeScript only). ' +
        'Automatically skips binary files unless skipBinary=false.',
      inputSchema: SearchContentInputSchema,
      outputSchema: SearchContentOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      path,
      pattern,
      filePattern,
      excludePatterns,
      caseSensitive,
      maxResults,
      maxFileSize,
      maxFilesScanned,
      timeoutMs,
      skipBinary,
      contextLines,
      wholeWord,
      isLiteral,
    }) => {
      const toolLogger = 'search_content';
      try {
        logger.info(
          `Starting search: pattern="${pattern}" in "${path}"`,
          toolLogger
        );

        const result = await searchContent(path, pattern, {
          filePattern,
          excludePatterns,
          caseSensitive,
          maxResults,
          maxFileSize,
          maxFilesScanned,
          timeoutMs,
          skipBinary,
          contextLines,
          wholeWord,
          isLiteral,
        });
        const structured = {
          ok: true,
          basePath: result.basePath,
          pattern: result.pattern,
          filePattern: result.filePattern,
          matches: result.matches.map((m) => ({
            file: nodePath.relative(result.basePath, m.file),
            line: m.line,
            content: m.content,
            contextBefore: m.contextBefore,
            contextAfter: m.contextAfter,
            matchCount: m.matchCount,
          })),
          summary: {
            filesScanned: result.summary.filesScanned,
            filesMatched: result.summary.filesMatched,
            totalMatches: result.summary.matches,
            truncated: result.summary.truncated,
            skippedTooLarge: result.summary.skippedTooLarge || undefined,
            skippedBinary: result.summary.skippedBinary || undefined,
            skippedInaccessible:
              result.summary.skippedInaccessible || undefined,
            linesSkippedDueToRegexTimeout:
              result.summary.linesSkippedDueToRegexTimeout || undefined,
            stoppedReason: result.summary.stoppedReason,
          },
        };

        logger.info(
          `Search complete: ${result.summary.matches} matches in ${result.summary.filesMatched} files (${result.summary.filesScanned} scanned)`,
          toolLogger
        );

        return {
          content: [
            { type: 'text', text: formatContentMatches(result.matches) },
          ],
          structuredContent: structured,
        };
      } catch (error) {
        logger.error(`Search failed: ${String(error)}`, toolLogger);
        return createErrorResponse(error, ErrorCode.E_UNKNOWN, path);
      }
    }
  );
}
