import * as pathModule from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createErrorResponse, ErrorCode } from '../lib/errors.js';
import { searchContent } from '../lib/file-operations.js';
import {
  formatContentMatches,
  formatOperationSummary,
} from '../lib/formatters.js';
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
      path: searchBasePath,
      pattern,
      filePattern,
      excludePatterns,
      caseSensitive,
      maxResults,
      maxFileSize,
      maxFilesScanned,
      timeoutMs,
      skipBinary,
      includeHidden,
      contextLines,
      wholeWord,
      isLiteral,
    }) => {
      try {
        const result = await searchContent(searchBasePath, pattern, {
          filePattern,
          excludePatterns,
          caseSensitive,
          maxResults,
          maxFileSize,
          maxFilesScanned,
          timeoutMs,
          skipBinary,
          includeHidden,
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
            file: pathModule.relative(result.basePath, m.file),
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

        // Build text output with truncation notice for better error recovery feedback
        let textOutput = formatContentMatches(result.matches);

        // Determine truncation reason and tip
        let truncatedReason: string | undefined;
        let tip: string | undefined;

        if (result.summary.truncated) {
          if (result.summary.stoppedReason === 'timeout') {
            truncatedReason = 'search timed out';
            tip =
              'Increase timeoutMs, use more specific filePattern, or add excludePatterns to narrow scope.';
          } else if (result.summary.stoppedReason === 'maxResults') {
            truncatedReason = `reached max results limit (${result.summary.matches})`;
          } else if (result.summary.stoppedReason === 'maxFiles') {
            truncatedReason = `reached max files limit (${result.summary.filesScanned} scanned)`;
          }
        }

        textOutput += formatOperationSummary({
          truncated: result.summary.truncated,
          truncatedReason,
          tip,
          skippedTooLarge: result.summary.skippedTooLarge,
          skippedBinary: result.summary.skippedBinary,
          skippedInaccessible: result.summary.skippedInaccessible,
          linesSkippedDueToRegexTimeout:
            result.summary.linesSkippedDueToRegexTimeout,
        });

        if (result.summary.truncated && !tip) {
          textOutput += `\nScanned ${result.summary.filesScanned} files, found ${result.summary.matches} matches in ${result.summary.filesMatched} files.`;
        }

        return {
          content: [{ type: 'text', text: textOutput }],
          structuredContent: structured,
        };
      } catch (error) {
        return createErrorResponse(error, ErrorCode.E_UNKNOWN, searchBasePath);
      }
    }
  );
}
