import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createErrorResponse, ErrorCode } from '../lib/errors.js';
import { readMediaFile } from '../lib/file-operations.js';
import {
  ReadMediaFileInputSchema,
  ReadMediaFileOutputSchema,
} from '../schemas/index.js';

export function registerReadMediaFileTool(server: McpServer): void {
  server.registerTool(
    'read_media_file',
    {
      title: 'Read Media File',
      description:
        'Read binary/media files (images, audio, fonts, etc.) and return as base64-encoded data with MIME type. ' +
        'Use this instead of read_file for non-text files. ' +
        'Supports common formats: PNG, JPG, GIF, WebP, SVG, MP3, WAV, TTF, WOFF2, etc.',
      inputSchema: ReadMediaFileInputSchema,
      outputSchema: ReadMediaFileOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ path, maxSize }) => {
      try {
        const result = await readMediaFile(path, { maxSize });

        // For text output, show summary not the full base64
        const textLines = [
          `File: ${result.path}`,
          `MIME Type: ${result.mimeType}`,
          `Size: ${result.size} bytes`,
        ];

        textLines.push(
          `Data: [base64 encoded, ${result.data.length} characters]`
        );
        const textOutput = textLines.join('\n');

        const structured = {
          ok: true,
          path: result.path,
          mimeType: result.mimeType,
          size: result.size,
          data: result.data,
        };

        return {
          content: [{ type: 'text', text: textOutput }],
          structuredContent: structured,
        };
      } catch (error) {
        return createErrorResponse(error, ErrorCode.E_NOT_FILE, path);
      }
    }
  );
}
