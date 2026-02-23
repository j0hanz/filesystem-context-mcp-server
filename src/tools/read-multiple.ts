import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import {
  DEFAULT_READ_MANY_MAX_TOTAL_SIZE,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { readMultipleFiles } from '../lib/file-operations/read-multiple-files.js';
import {
  ReadMultipleFilesInputSchema,
  ReadMultipleFilesOutputSchema,
} from '../schemas.js';
import {
  buildResourceLink,
  buildToolErrorResponse,
  buildToolResponse,
  createProgressReporter,
  executeToolWithDiagnostics,
  maybeExternalizeTextContent,
  notifyProgress,
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

export const READ_MULTIPLE_FILES_TOOL: ToolContract = {
  name: 'read_many',
  title: 'Read Multiple Files',
  description:
    'Read multiple text files in a single request. ' +
    'Returns contents and metadata for each file. ' +
    'For single file, use read for simpler output.',
  inputSchema: ReadMultipleFilesInputSchema,
  outputSchema: ReadMultipleFilesOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  taskSupport: 'optional',
  nuances: ['Total read budget is capped by `MAX_READ_MANY_TOTAL_SIZE`.'],
  gotchas: [
    'Per-file `truncationReason` can be `head`, `range`, or `externalized`.',
  ],
} as const;

async function handleReadMultipleFiles(
  args: z.infer<typeof ReadMultipleFilesInputSchema>,
  signal?: AbortSignal,
  resourceStore?: ToolRegistrationOptions['resourceStore'],
  onReadComplete?: () => void
): Promise<ToolResponse<z.infer<typeof ReadMultipleFilesOutputSchema>>> {
  const options: Parameters<typeof readMultipleFiles>[1] = {
    ...(signal ? { signal } : {}),
    ...(args.head !== undefined ? { head: args.head } : {}),
    ...(args.startLine !== undefined ? { startLine: args.startLine } : {}),
    ...(args.endLine !== undefined ? { endLine: args.endLine } : {}),
    ...(onReadComplete ? { onReadComplete } : {}),
  };
  const results = await readMultipleFiles(args.paths, options);

  const maxTotalSize = DEFAULT_READ_MANY_MAX_TOTAL_SIZE;

  type ReadManyResult = Awaited<ReturnType<typeof readMultipleFiles>>[number];
  type ReadManyResultWithResource = ReadManyResult & {
    resourceUri?: string;
    truncationReason?: 'head' | 'range' | 'externalized';
    maxTotalSize?: number;
  };

  const mappedResults: ReadManyResultWithResource[] = results.map((result) => {
    let baseTruncationReason: 'head' | 'range' | undefined;
    if (result.truncated && result.readMode === 'head') {
      baseTruncationReason = 'head';
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
    results: mappedResults.map((result) => ({
      path: result.path,
      ...(result.content !== undefined ? { content: result.content } : {}),
      ...(result.truncated ? { truncated: result.truncated } : {}),
      ...(result.resourceUri ? { resourceUri: result.resourceUri } : {}),
      ...(result.head !== undefined ? { head: result.head } : {}),
      ...(result.startLine !== undefined
        ? { startLine: result.startLine }
        : {}),
      ...(result.endLine !== undefined ? { endLine: result.endLine } : {}),
      ...(result.hasMoreLines ? { hasMoreLines: result.hasMoreLines } : {}),
      ...(result.totalLines !== undefined
        ? { totalLines: result.totalLines }
        : {}),
      ...(result.truncationReason
        ? { truncationReason: result.truncationReason }
        : {}),
      ...(result.error ? { error: result.error } : {}),
    })),
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
        const first = path.basename(args.paths[0] ?? '');
        const extraPaths =
          args.paths.length > 1
            ? `, ${path.basename(args.paths[1] ?? '')}${args.paths.length > 2 ? '…' : ''}`
            : '';
        const context = `${args.paths.length} files [${first}${extraPaths}]`;
        let progressCursor = 0;

        notifyProgress(extra, {
          current: 0,
          message: `🕮 read_many: ${context}`,
        });

        const baseReporter = createProgressReporter(extra);
        const onReadComplete = (): void => {
          progressCursor++;
          baseReporter({
            current: progressCursor,
            message: `🕮 read_many: ${context} [${progressCursor}/${args.paths.length} read]`,
          });
        };

        try {
          const result = await handleReadMultipleFiles(
            args,
            signal,
            options.resourceStore,
            onReadComplete
          );

          const sc = result.structuredContent;
          const total = sc.summary?.total ?? 0;
          const failed = sc.summary?.failed ?? 0;
          const succeeded = sc.summary?.succeeded ?? 0;

          let suffix: string;
          if (failed) {
            suffix = `${succeeded}/${total} read, ${failed} failed`;
          } else {
            suffix = `${total} files read`;
          }

          const finalCurrent = Math.max(total, progressCursor + 1);
          notifyProgress(extra, {
            current: finalCurrent,
            total: finalCurrent,
            message: `🕮 read_many: ${context} • ${suffix}`,
          });
          return result;
        } catch (error) {
          const finalCurrent = Math.max(progressCursor + 1, 1);
          notifyProgress(extra, {
            current: finalCurrent,
            total: finalCurrent,
            message: `🕮 read_many: ${context} • failed`,
          });
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
