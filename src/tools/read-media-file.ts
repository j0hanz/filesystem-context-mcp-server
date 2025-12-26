import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode } from '../lib/errors.js';
import { readMediaFile } from '../lib/file-operations.js';
import {
  ReadMediaFileInputSchema,
  ReadMediaFileOutputSchema,
} from '../schemas/index.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
} from './tool-response.js';

type ReadMediaArgs = z.infer<z.ZodObject<typeof ReadMediaFileInputSchema>>;
type ReadMediaStructuredResult = z.infer<typeof ReadMediaFileOutputSchema>;

function buildStructuredResult(
  result: Awaited<ReturnType<typeof readMediaFile>>
): ReadMediaStructuredResult {
  return {
    ok: true,
    path: result.path,
    mimeType: result.mimeType,
    size: result.size,
    data: result.data,
  };
}

function buildTextResult(
  result: Awaited<ReturnType<typeof readMediaFile>>
): string {
  const textLines = [
    `File: ${result.path}`,
    `MIME Type: ${result.mimeType}`,
    `Size: ${result.size} bytes`,
    `Data: [base64 encoded, ${result.data.length} characters]`,
  ];
  return textLines.join('\n');
}

async function handleReadMediaFile({
  path,
  maxSize,
}: {
  path: string;
  maxSize?: number;
}): Promise<ToolResponse<ReadMediaStructuredResult>> {
  const result = await readMediaFile(path, { maxSize });
  return buildToolResponse(
    buildTextResult(result),
    buildStructuredResult(result)
  );
}

const READ_MEDIA_FILE_TOOL = {
  title: 'Read Media File',
  description:
    'Read binary/media files (images, audio, fonts, etc.) and return as base64-encoded data with MIME type. ' +
    'Use this instead of read_file for non-text files. ' +
    'Supports common formats: PNG, JPG, GIF, WebP, SVG, MP3, WAV, TTF, WOFF2, etc.',
  inputSchema: ReadMediaFileInputSchema,
  outputSchema: ReadMediaFileOutputSchema.shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

const READ_MEDIA_FILE_TOOL_DEPRECATED = {
  ...READ_MEDIA_FILE_TOOL,
  description: `${READ_MEDIA_FILE_TOOL.description} (Deprecated: use readMediaFile.)`,
} as const;

export function registerReadMediaFileTool(server: McpServer): void {
  const handler = async (
    args: ReadMediaArgs
  ): Promise<ToolResult<ReadMediaStructuredResult>> => {
    try {
      return await handleReadMediaFile(args);
    } catch (error: unknown) {
      return buildToolErrorResponse(error, ErrorCode.E_NOT_FILE, args.path);
    }
  };

  server.registerTool(
    'read_media_file',
    READ_MEDIA_FILE_TOOL_DEPRECATED,
    handler
  );
  server.registerTool('readMediaFile', READ_MEDIA_FILE_TOOL, handler);
}
