import * as path from 'node:path';
import { createHash } from 'node:crypto';

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
    'Read text file contents. ' +
    'Use `head` to preview first N lines of large files. ' +
    'For multiple files, use `read_many`.',
  inputSchema: ReadFileInputSchema,
  outputSchema: ReadFileOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  nuances: [
    'Large content is externalized to `filesystem-mcp://result/{id}` and preview is returned inline.',
  ],
  taskSupport: 'forbidden',
} as const;

type ReadFileInput = z.infer<typeof ReadFileInputSchema>;
type ReadFileOutput = z.infer<typeof ReadFileOutputSchema>;
type ReadFileHandlerResult = Awaited<ReturnType<typeof readFile>>;

const READ_TOOL_NAME = 'read';
const READ_TOOL_LABEL = '🕮 read';
const FULL_FILE_CONTENTS_DESCRIPTION = 'Full file contents';

function buildReadResourceName(filePath: string): string {
  return `read:${path.basename(filePath)}`;
}

function buildReadOptions(
  args: ReadFileInput,
  signal?: AbortSignal
): Parameters<typeof readFile>[1] {
  const options: Parameters<typeof readFile>[1] = {
    encoding: 'utf-8',
    maxSize: MAX_TEXT_FILE_SIZE,
    skipBinary: true,
  };

  if (signal) options.signal = signal;
  if (args.head !== undefined) options.head = args.head;
  if (args.tail !== undefined) options.tail = args.tail;
  if (args.startLine !== undefined) options.startLine = args.startLine;
  if (args.endLine !== undefined) options.endLine = args.endLine;

  return options;
}

function toStructuredReadFileResult(
  args: ReadFileInput,
  result: ReadFileHandlerResult
): ReadFileOutput {
  const structured: ReadFileOutput = {
    ok: true,
    path: args.path,
    content: result.content,
  };

  if (result.truncated) structured.truncated = true;
  if (result.totalLines !== undefined)
    structured.totalLines = result.totalLines;
  if (result.head !== undefined) structured.head = result.head;
  if (result.tail !== undefined) structured.tail = result.tail;
  if (result.startLine !== undefined) structured.startLine = result.startLine;
  if (result.endLine !== undefined) structured.endLine = result.endLine;
  if (result.linesRead !== undefined) structured.linesRead = result.linesRead;
  if (result.hasMoreLines) structured.hasMoreLines = true;

  return structured;
}

function maybeBuildExternalizedReadResponse(
  filePath: string,
  content: string,
  structured: ReadFileOutput,
  resourceStore?: ToolRegistrationOptions['resourceStore']
): ToolResponse<ReadFileOutput> | undefined {
  const externalized = maybeExternalizeTextContent(resourceStore, content, {
    name: buildReadResourceName(filePath),
    mimeType: 'text/plain',
  });
  if (!externalized) {
    return undefined;
  }

  const { entry, preview } = externalized;
  const structuredWithResource: ReadFileOutput = {
    ...structured,
    content: preview,
    truncated: true,
    resourceUri: entry.uri,
  };

  const text = [
    `Output too large to inline (${content.length} chars).`,
    'Preview:',
    preview,
  ].join('\n');

  return buildToolResponse(text, structuredWithResource, [
    buildResourceLink({
      uri: entry.uri,
      name: entry.name,
      mimeType: entry.mimeType,
      description: FULL_FILE_CONTENTS_DESCRIPTION,
      expiresAt: entry.expiresAt,
    }),
  ]);
}

function buildReadProgressMessage(args: ReadFileInput): string {
  const name = path.basename(args.path);
  if (args.startLine !== undefined) {
    const end = args.endLine ?? '…';
    return `${READ_TOOL_LABEL}: ${name} [lines ${args.startLine}–${end}]`;
  }
  if (args.head !== undefined)
    return `${READ_TOOL_LABEL}: ${name} [head ${args.head}]`;
  if (args.tail !== undefined)
    return `${READ_TOOL_LABEL}: ${name} [tail ${args.tail}]`;
  return `${READ_TOOL_LABEL}: ${name}`;
}

function buildReadCompletionMessage(
  args: ReadFileInput,
  result: ToolResult<ReadFileOutput>
): string {
  const name = path.basename(args.path);
  if (result.isError) return `${READ_TOOL_LABEL}: ${name} • failed`;

  const structured = result.structuredContent;
  if (!structured.ok) return `${READ_TOOL_LABEL}: ${name} • failed`;

  const lines = structured.linesRead ?? structured.totalLines;

  if (structured.startLine !== undefined) {
    const end = structured.linesRead
      ? structured.startLine + structured.linesRead - 1
      : (structured.endLine ?? '…');
    return `${READ_TOOL_LABEL}: ${name} • lines ${structured.startLine}–${end}`;
  }

  if (structured.head !== undefined) {
    return structured.hasMoreLines
      ? `${READ_TOOL_LABEL}: ${name} • first ${String(lines ?? structured.head)} lines`
      : `${READ_TOOL_LABEL}: ${name} • ${String(lines ?? structured.head)} lines`;
  }

  if (structured.tail !== undefined) {
    return structured.hasMoreLines
      ? `${READ_TOOL_LABEL}: ${name} • last ${String(lines ?? structured.tail)} lines`
      : `${READ_TOOL_LABEL}: ${name} • ${String(lines ?? structured.tail)} lines`;
  }

  if (structured.truncated) {
    return `${READ_TOOL_LABEL}: ${name} • truncated [${String(lines)} lines]`;
  }

  return `${READ_TOOL_LABEL}: ${name} • ${String(lines)} lines`;
}

async function handleReadFile(
  args: ReadFileInput,
  signal?: AbortSignal,
  resourceStore?: ToolRegistrationOptions['resourceStore']
): Promise<ToolResponse<ReadFileOutput>> {
  const options = buildReadOptions(args, signal);
  const result = await readFile(args.path, options);
  const structured = toStructuredReadFileResult(args, result);

  if (args.includeHash) {
    structured.contentHash = createHash('sha256')
      .update(result.content, 'utf-8')
      .digest('hex');
  }

  const externalizedResponse = maybeBuildExternalizedReadResponse(
    args.path,
    result.content,
    structured,
    resourceStore
  );
  if (externalizedResponse) {
    return externalizedResponse;
  }

  return buildToolResponse(result.content, structured);
}

export function registerReadFileTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: ReadFileInput,
    extra: ToolExtra
  ): Promise<ToolResult<ReadFileOutput>> =>
    executeToolWithDiagnostics({
      toolName: READ_TOOL_NAME,
      extra,
      outputSchema: ReadFileOutputSchema,
      timedSignal: { timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS },
      context: { path: args.path },
      run: (signal) => handleReadFile(args, signal, options.resourceStore),
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.E_NOT_FILE, args.path),
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    progressMessage: buildReadProgressMessage,
    completionMessage: buildReadCompletionMessage,
  });

  const validatedHandler = withValidatedArgs(
    ReadFileInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      READ_TOOL_NAME,
      READ_FILE_TOOL,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  )
    return;
  server.registerTool(
    READ_TOOL_NAME,
    withDefaultIcons({ ...READ_FILE_TOOL }, options.iconInfo),
    validatedHandler
  );
}
