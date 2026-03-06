import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import {
  DEFAULT_READ_MANY_MAX_TOTAL_SIZE,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { readMultipleFiles } from '../lib/file-operations/metadata.js';

import {
  ReadMultipleFilesInputSchema,
  ReadMultipleFilesOutputSchema,
} from '../schemas.js';
import {
  buildBatchCompletionSuffix,
  buildBatchPathContext,
  buildResourceLink,
  buildToolErrorResponse,
  buildToolResponse,
  createBatchProgressCallbacks,
  executeToolWithDiagnostics,
  maybeExternalizeTextContent,
  READ_ONLY_TOOL_ANNOTATIONS,
  resolveFinalProgressCurrent,
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

export const READ_MULTIPLE_FILES_TOOL: ToolContract = {
  name: 'read_many',
  title: 'Read Multiple Files',
  description:
    'Read multiple text files in one request with contents and metadata. ' +
    'For a single file, use `read`.',
  inputSchema: ReadMultipleFilesInputSchema,
  outputSchema: ReadMultipleFilesOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  taskSupport: 'optional',
  nuances: ['Total read budget is capped by `MAX_READ_MANY_TOTAL_SIZE`.'],
  gotchas: [
    'Per-file `truncationReason` can be `head`, `tail`, `range`, or `externalized`.',
  ],
} as const;

type ReadManyStructuredResult = z.infer<typeof ReadMultipleFilesOutputSchema>;
type ReadManyStructuredResultItem = NonNullable<
  ReadManyStructuredResult['results']
>[number];

function toStructuredReadManyResult(
  result: Awaited<ReturnType<typeof readMultipleFiles>>[number] & {
    resourceUri?: string;
    truncationReason?: 'head' | 'tail' | 'range' | 'externalized';
    maxTotalSize?: number;
  }
): ReadManyStructuredResultItem {
  const structured: ReadManyStructuredResultItem = {
    path: result.path,
  };
  if (result.content !== undefined) structured.content = result.content;
  if (result.truncated) structured.truncated = result.truncated;
  if (result.resourceUri) structured.resourceUri = result.resourceUri;
  if (result.head !== undefined) structured.head = result.head;
  if (result.tail !== undefined) structured.tail = result.tail;
  if (result.startLine !== undefined) structured.startLine = result.startLine;
  if (result.endLine !== undefined) structured.endLine = result.endLine;
  if (result.hasMoreLines) structured.hasMoreLines = result.hasMoreLines;
  if (result.totalLines !== undefined)
    structured.totalLines = result.totalLines;
  if (result.linesRead !== undefined) structured.linesRead = result.linesRead;
  if (result.truncationReason) {
    structured.truncationReason = result.truncationReason;
  }
  if (result.error) structured.error = result.error;
  return structured;
}

async function handleReadMultipleFiles(
  args: z.infer<typeof ReadMultipleFilesInputSchema>,
  signal?: AbortSignal,
  resourceStore?: ToolRegistrationOptions['resourceStore'],
  onReadComplete?: () => void
): Promise<ToolResponse<z.infer<typeof ReadMultipleFilesOutputSchema>>> {
  const options: Parameters<typeof readMultipleFiles>[1] = {
    ...(signal ? { signal } : {}),
    ...(args.head !== undefined ? { head: args.head } : {}),
    ...(args.tail !== undefined ? { tail: args.tail } : {}),
    ...(args.startLine !== undefined ? { startLine: args.startLine } : {}),
    ...(args.endLine !== undefined ? { endLine: args.endLine } : {}),
    ...(onReadComplete ? { onReadComplete } : {}),
  };
  const results = await readMultipleFiles(args.paths, options);

  const maxTotalSize = DEFAULT_READ_MANY_MAX_TOTAL_SIZE;

  type ReadManyResult = Awaited<ReturnType<typeof readMultipleFiles>>[number];
  type ReadManyResultWithResource = ReadManyResult & {
    resourceUri?: string;
    truncationReason?: 'head' | 'tail' | 'range' | 'externalized';
    maxTotalSize?: number;
  };

  const mappedResults: ReadManyResultWithResource[] = results.map((result) => {
    let baseTruncationReason: 'head' | 'tail' | 'range' | undefined;
    if (result.truncated && result.readMode === 'head') {
      baseTruncationReason = 'head';
    } else if (result.truncated && result.readMode === 'tail') {
      baseTruncationReason = 'tail';
    } else if (result.truncated && result.readMode === 'range') {
      baseTruncationReason = 'range';
    }

    const baseResult: ReadManyResultWithResource = {
      ...result,
      maxTotalSize,
      ...(baseTruncationReason
        ? { truncationReason: baseTruncationReason }
        : {}),
    };

    if (!result.content) {
      return baseResult;
    }

    const externalized = maybeExternalizeTextContent(
      resourceStore,
      result.content,
      { name: `read:${path.basename(result.path)}`, mimeType: 'text/plain' }
    );
    if (!externalized) {
      return baseResult;
    }

    return {
      ...baseResult,
      content: externalized.preview,
      truncated: true,
      resourceUri: externalized.entry.uri,
      truncationReason: 'externalized',
    };
  });

  let succeeded = 0;
  let failed = 0;
  for (const result of mappedResults) {
    if (result.error === undefined) succeeded += 1;
    else failed += 1;
  }

  const structured: z.infer<typeof ReadMultipleFilesOutputSchema> = {
    ok: true,
    results: mappedResults.map((result) => toStructuredReadManyResult(result)),
    summary: {
      total: mappedResults.length,
      succeeded,
      failed,
    },
  };

  const resourceLinks: ReturnType<typeof buildResourceLink>[] = [];
  for (const result of mappedResults) {
    if (!result.resourceUri) continue;
    resourceLinks.push(
      buildResourceLink({
        uri: result.resourceUri,
        name: `read:${path.basename(result.path)}`,
        description: 'Full file contents',
      })
    );
  }

  const text = mappedResults
    .map((result) => {
      const header = `=== ${result.path} ===`;
      if (result.error) {
        return `${header}\nError: ${result.error}`;
      }
      return `${header}\n${result.content ?? ''}`;
    })
    .join('\n\n');

  return buildToolResponse(text, structured, resourceLinks);
}

export function registerReadMultipleFilesTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof ReadMultipleFilesInputSchema>,
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof ReadMultipleFilesOutputSchema>>> => {
    const primaryPath = args.paths[0] ?? '';
    return executeToolWithDiagnostics({
      toolName: 'read_many',
      extra,
      timedSignal: { timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS },
      context: { path: primaryPath },
      run: async (signal) => {
        const context = buildBatchPathContext(args.paths, 'files');
        const { progress, onItemComplete } = createBatchProgressCallbacks(
          extra,
          {
            toolLabel: '🕮 read_many',
            context,
            totalItems: args.paths.length,
            itemVerb: 'read',
          }
        );

        try {
          const result = await handleReadMultipleFiles(
            args,
            signal,
            options.resourceStore,
            onItemComplete
          );

          const sc = result.structuredContent;
          const suffix = buildBatchCompletionSuffix(
            sc.summary,
            'files read',
            'file read'
          );
          const total = sc.summary?.total ?? 0;

          const finalCurrent = resolveFinalProgressCurrent(progress, total);
          progress.complete(
            `🕮 read_many: ${context} • ${suffix}`,
            finalCurrent
          );
          return result;
        } catch (error) {
          progress.fail(`🕮 read_many: ${context} • failed`);
          throw error;
        }
      },
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.E_NOT_FILE, primaryPath),
    });
  };

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
  });

  const validatedHandler = withValidatedArgs(
    ReadMultipleFilesInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      'read_many',
      READ_MULTIPLE_FILES_TOOL,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  )
    return;
  server.registerTool(
    'read_many',
    withDefaultIcons({ ...READ_MULTIPLE_FILES_TOOL }, options.iconInfo),
    validatedHandler
  );
}
