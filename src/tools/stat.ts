import type { z } from 'zod/v4';

import { DEFAULT_SEARCH_TIMEOUT_MS } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { getFileInfo } from '../lib/file-operations/metadata.js';
import { StatInputSchema } from '../schemas/inputs.js';
import { StatOutputSchema } from '../schemas/outputs.js';

import { type FileInfo, formatBytes, joinLines } from '../config.js';
import {
  buildPathMessages,
  defineTool,
  type ToolRunContext,
} from './define-tool.js';
import { FILE_READ_ICONS } from './icons.js';
import {
  buildFileInfoPayload,
  buildToolResponse,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolContract,
} from './shared.js';

const GET_FILE_INFO_TOOL: ToolContract = {
  name: 'stat',
  title: 'Get File Info',
  description:
    'Get file/directory metadata: size, modified, permissions, mime, tokenEstimate. ' +
    'Use `tokenEstimate` (size\u00f74) to pre-screen token cost before reading.',
  inputSchema: StatInputSchema,
  outputSchema: StatOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: FILE_READ_ICONS,
  taskSupport: 'forbidden',
  defaultTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
} as const;

function formatFileInfoDetails(info: FileInfo): string {
  const lines = [
    `${info.name} (${info.type})`,
    `  Path: ${info.path}`,
    `  Size: ${formatBytes(info.size)}`,
    `  Modified: ${info.modified.toISOString()}`,
  ];

  if (info.mimeType) lines.push(`  Type: ${info.mimeType}`);
  if (info.symlinkTarget) lines.push(`  Target: ${info.symlinkTarget}`);

  return joinLines(lines);
}

type StatInput = z.infer<typeof StatInputSchema>;
type StatOutput = z.infer<typeof StatOutputSchema>;

const statMessages = buildPathMessages<StatInput, StatOutput>(
  GET_FILE_INFO_TOOL.title,
  (sc) => `${sc.file.name} \u2022 ${formatBytes(sc.file.size)}`
);

export const GET_FILE_INFO = defineTool<StatInput, StatOutput>({
  contract: GET_FILE_INFO_TOOL,
  run: async (args, ctx: ToolRunContext) => {
    const info = await getFileInfo(args.path, {
      includeMimeType: true,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    const structured: z.infer<typeof StatOutputSchema> = {
      ok: true,
      file: buildFileInfoPayload(info),
    };

    return buildToolResponse(formatFileInfoDetails(info), structured);
  },
  defaultErrorCode: ErrorCode.NOT_FOUND,
  ...statMessages,
});
