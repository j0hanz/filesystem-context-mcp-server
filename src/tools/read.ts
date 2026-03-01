import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import {
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_TEXT_FILE_SIZE,
} from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { readFile } from '../lib/fs-helpers.js';

import { ReadFileInputSchema, ReadFileOutputSchema } from '../schemas.js';
import {
  buildResourceLink,
  buildToolErrorResponse,
  buildToolResponse,
  executeToolWithDiagnostics,
  maybeExternalizeTextContent,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolContract,
  type ToolExtra,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
  withDefaultIcons,
  withValidatedArgs,
  wrapToolHandler,
} from './shared.js';
import { registerToolTaskIfAvailable } from './task-support.js';

export const READ_FILE_TOOL: ToolContract = {
  name: 'read',
  title: 'Read File',
  description:
    'Read the text contents of a file. ' +
    'Use head parameter to preview the first N lines of large files. ' +
    'For multiple files, use read_many for efficiency.',
  inputSchema: ReadFileInputSchema,
  outputSchema: ReadFileOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  nuances: [
    'Large content is externalized to `filesystem-mcp://result/{id}` and preview is returned inline.',
  ],
} as const;

async function handleReadFile(
  args: z.infer<typeof ReadFileInputSchema>,
  signal?: AbortSignal,
  resourceStore?: ToolRegistrationOptions['resourceStore']
): Promise<ToolResponse<z.infer<typeof ReadFileOutputSchema>>> {
  const options: Parameters<typeof readFile>[1] = {
    encoding: 'utf-8',
    maxSize: MAX_TEXT_FILE_SIZE,
    skipBinary: true,
  };
  if (args.head !== undefined) {
    options.head = args.head;
  }
  if (args.startLine !== undefined) {
    options.startLine = args.startLine;
  }
  if (args.endLine !== undefined) {
    options.endLine = args.endLine;
  }
  if (signal) {
    options.signal = signal;
  }
  const result = await readFile(args.path, options);

  const structured: z.infer<typeof ReadFileOutputSchema> = {
    ok: true,
    path: args.path,
    content: result.content,
    ...(result.truncated ? { truncated: result.truncated } : {}),
    ...(result.totalLines !== undefined
      ? { totalLines: result.totalLines }
      : {}),
    ...(result.head !== undefined ? { head: result.head } : {}),
    ...(result.startLine !== undefined ? { startLine: result.startLine } : {}),
    ...(result.endLine !== undefined ? { endLine: result.endLine } : {}),
    ...(result.hasMoreLines ? { hasMoreLines: result.hasMoreLines } : {}),
  };

  const externalized = maybeExternalizeTextContent(
    resourceStore,
    result.content,
    { name: `read:${path.basename(args.path)}`, mimeType: 'text/plain' }
  );
  if (!externalized) {
    return buildToolResponse(result.content, structured);
  }

  const { entry, preview } = externalized;
  const structuredWithResource: z.infer<typeof ReadFileOutputSchema> = {
    ...structured,
    content: preview,
    truncated: true,
    resourceUri: entry.uri,
  };

  const text = [
    `Output too large to inline (${result.content.length} chars).`,
    'Preview:',
    preview,
  ].join('\n');

  return buildToolResponse(text, structuredWithResource, [
    buildResourceLink({
      uri: entry.uri,
      name: entry.name,
      mimeType: entry.mimeType,
      description: 'Full file contents',
    }),
  ]);
}

export function registerReadFileTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof ReadFileInputSchema>,
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof ReadFileOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'read',
      extra,
      timedSignal: { timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS },
      context: { path: args.path },
      run: (signal) => handleReadFile(args, signal, options.resourceStore),
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.E_NOT_FILE, args.path),
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    progressMessage: (args) => {
      const name = path.basename(args.path);
      if (args.startLine !== undefined) {
        const end = args.endLine ?? '…';
        return `🕮 read: ${name} [${args.startLine}-${end}]`;
      }
      return `🕮 read: ${name}`;
    },
    completionMessage: (args, result) => {
      const name = path.basename(args.path);
      if (result.isError) return `🕮 read: ${name} • failed`;
      const sc = result.structuredContent;
      if (!sc.ok) return `🕮 read: ${name} • failed`;
      if (sc.hasMoreLines)
        return `🕮 read: ${name} • truncated [${sc.totalLines ?? '?'} lines]`;
      if (sc.startLine !== undefined)
        return `🕮 read: ${name} • lines ${sc.startLine}–${sc.endLine ?? '?'}`;
      return `🕮 read: ${name} • ${sc.totalLines ?? '?'} lines`;
    },
  });

  const validatedHandler = withValidatedArgs(
    ReadFileInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      'read',
      READ_FILE_TOOL,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  )
    return;
  server.registerTool(
    'read',
    withDefaultIcons({ ...READ_FILE_TOOL }, options.iconInfo),
    validatedHandler
  );
}
