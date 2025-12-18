import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createErrorResponse, ErrorCode, McpError } from '../lib/errors.js';
import { readFile } from '../lib/file-operations.js';
import { ReadFileInputSchema, ReadFileOutputSchema } from '../schemas/index.js';

// Inline validation for line range parameters
function validateLineRange(params: {
  lineStart?: number;
  lineEnd?: number;
  head?: number;
  tail?: number;
  path: string;
}): void {
  const { lineStart, lineEnd, head, tail, path } = params;

  // Validate that both or neither of lineStart and lineEnd are provided
  if ((lineStart !== undefined) !== (lineEnd !== undefined)) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'lineStart and lineEnd must be specified together',
      path
    );
  }

  // Validate mutual exclusivity of line range options
  const optionsCount = [
    lineStart !== undefined,
    head !== undefined,
    tail !== undefined,
  ].filter(Boolean).length;

  if (optionsCount > 1) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Cannot specify multiple of lineRange, head, or tail',
      path
    );
  }
}

export function registerReadFileTool(server: McpServer): void {
  server.registerTool(
    'read_file',
    {
      title: 'Read File',
      description:
        'Read the text contents of a single file. ' +
        'Supports different encodings and partial reads via head (first N lines), tail (last N lines), ' +
        'or lineStart/lineEnd (specific line range). ' +
        'For multiple files, use read_multiple_files for efficiency. ' +
        'For binary/media files, use read_media_file instead.',
      inputSchema: ReadFileInputSchema,
      outputSchema: ReadFileOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ path, encoding, maxSize, lineStart, lineEnd, head, tail }) => {
      try {
        // Validate lineRange parameters early (before file I/O)
        validateLineRange({ lineStart, lineEnd, head, tail, path });

        const lineRange =
          lineStart !== undefined && lineEnd !== undefined
            ? { start: lineStart, end: lineEnd }
            : undefined;

        const result = await readFile(path, {
          encoding,
          maxSize,
          lineRange,
          head,
          tail,
        });

        let text = result.content;
        if (result.truncated) {
          if (result.totalLines) {
            text += `\n\n[Showing requested lines. Total lines in file: ${result.totalLines}]`;
          } else if (head !== undefined) {
            text += `\n\n[Showing first ${String(head)} lines]`;
          } else if (tail !== undefined) {
            text += `\n\n[Showing last ${String(tail)} lines]`;
          }
        } else if (result.totalLines) {
          text += `\n\n[Total lines: ${result.totalLines}]`;
        }

        const structured = {
          ok: true,
          path,
          content: result.content,
          truncated: result.truncated,
          totalLines: result.totalLines,
        };

        return {
          content: [{ type: 'text', text }],
          structuredContent: structured,
        };
      } catch (error) {
        return createErrorResponse(error, ErrorCode.E_NOT_FILE, path);
      }
    }
  );
}
