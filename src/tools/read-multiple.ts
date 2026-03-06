import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { DEFAULT_SEARCH_TIMEOUT_MS } from '../lib/constants.js';
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
type ReadManyResult = Awaited<ReturnType<typeof readMultipleFiles>>[number];
type ReadManyTruncationReason = 'head' | 'tail' | 'range' | 'externalized';
type ReadManyResultWithResource = ReadManyResult & {
  resourceUri?: string;
  truncationReason?: ReadManyTruncationReason;
};

function toStructuredReadManyResult(
  result: ReadManyResultWithResource
): ReadManyStructuredResultItem {
  return {
    path: result.path,
    ...(result.content !== undefined ? { content: result.content } : {}),
    ...(result.truncated ? { truncated: result.truncated } : {}),
    ...(result.resourceUri ? { resourceUri: result.resourceUri } : {}),
    ...(result.head !== undefined ? { head: result.head } : {}),
    ...(result.tail !== undefined ? { tail: result.tail } : {}),
    ...(result.startLine !== undefined ? { startLine: result.startLine } : {}),
    ...(result.endLine !== undefined ? { endLine: result.endLine } : {}),
    ...(result.hasMoreLines ? { hasMoreLines: result.hasMoreLines } : {}),
    ...(result.totalLines !== undefined
      ? { totalLines: result.totalLines }
      : {}),
    ...(result.linesRead !== undefined ? { linesRead: result.linesRead } : {}),
    ...(result.truncationReason
      ? { truncationReason: result.truncationReason }
      : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

function resolveReadManyTruncationReason(
  result: ReadManyResult
): Exclude<ReadManyTruncationReason, 'externalized'> | undefined {
  if (!result.truncated) return undefined;
  if (result.readMode === 'head') return 'head';
  if (result.readMode === 'tail') return 'tail';
  if (result.readMode === 'range') return 'range';
  return undefined;
}

function maybeExternalizeReadManyResult(
  result: ReadManyResult,
  resourceStore?: ToolRegistrationOptions['resourceStore']
): ReadManyResultWithResource {
  const truncationReason = resolveReadManyTruncationReason(result);
  const baseResult: ReadManyResultWithResource = {
    ...result,
    ...(truncationReason ? { truncationReason } : {}),
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
}

function buildReadManyResourceLinks(
  results: readonly ReadManyResultWithResource[]
): ReturnType<typeof buildResourceLink>[] {
  return results.flatMap((result) => {
    if (!result.resourceUri) return [];
    return [
      buildResourceLink({
        uri: result.resourceUri,
        name: `read:${path.basename(result.path)}`,
        description: 'Full file contents',
      }),
    ];
  });
}

function buildReadManyTextResult(
  results: readonly ReadManyResultWithResource[]
): string {
  return results
    .map((result) => {
      const header = `=== ${result.path} ===`;
      if (result.error) {
        return `${header}\nError: ${result.error}`;
      }
      return `${header}\n${result.content ?? ''}`;
    })
    .join('\n\n');
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

  const mappedResults = results.map((result) =>
    maybeExternalizeReadManyResult(result, resourceStore)
  );

  const succeeded = mappedResults.filter((r) => r.error === undefined).length;
  const failed = mappedResults.length - succeeded;

  const structured: z.infer<typeof ReadMultipleFilesOutputSchema> = {
    ok: true,
    results: mappedResults.map((result) => toStructuredReadManyResult(result)),
    summary: {
      total: mappedResults.length,
      succeeded,
      failed,
    },
  };

  return buildToolResponse(
    buildReadManyTextResult(mappedResults),
    structured,
    buildReadManyResourceLinks(mappedResults)
  );
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
