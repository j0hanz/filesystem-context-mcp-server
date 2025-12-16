import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createErrorResponse, ErrorCode } from '../lib/errors.js';
import { readMultipleFiles } from '../lib/file-operations.js';
import {
  ReadMultipleFilesInputSchema,
  ReadMultipleFilesOutputSchema,
} from '../schemas/index.js';
import { validateHeadTail } from '../schemas/validators.js';

export function registerReadMultipleFilesTool(server: McpServer): void {
  server.registerTool(
    'read_multiple_files',
    {
      title: 'Read Multiple Files',
      description:
        'Read contents of multiple files in a single operation (parallel processing). ' +
        'More efficient than calling read_file repeatedly. ' +
        'Individual file errors do not fail the entire operation—each file reports success or error independently. ' +
        'Supports head/tail for reading partial content from all files.',
      inputSchema: ReadMultipleFilesInputSchema,
      outputSchema: ReadMultipleFilesOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ paths, encoding, maxSize, maxTotalSize, head, tail }) => {
      try {
        // Validate head/tail mutual exclusivity early
        validateHeadTail({ head, tail });

        // Read multiple files in parallel
        const results = await readMultipleFiles(paths, {
          encoding,
          maxSize,
          maxTotalSize,
          head,
          tail,
        });

        const succeeded = results.filter((r) => r.content !== undefined).length;
        const failed = results.filter((r) => r.error !== undefined).length;

        // Format text output
        const textParts: string[] = [];
        for (const result of results) {
          if (result.content !== undefined) {
            textParts.push(`=== ${result.path} ===\n${result.content}`);
          } else {
            textParts.push(
              `=== ${result.path} ===\n[Error: ${result.error ?? 'Unknown error'}]`
            );
          }
        }

        const structured = {
          ok: true,
          results,
          summary: {
            total: results.length,
            succeeded,
            failed,
          },
        };

        return {
          content: [{ type: 'text', text: textParts.join('\n\n') }],
          structuredContent: structured,
        };
      } catch (error) {
        return createErrorResponse(error, ErrorCode.E_UNKNOWN);
      }
    }
  );
}
