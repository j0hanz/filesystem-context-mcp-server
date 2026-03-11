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

const READ_MANY_TOOL_NAME = 'read_many';
const READ_MANY_TOOL_LABEL = '🕮 read_many';
const FULL_FILE_CONTENTS_DESCRIPTION = 'Full file contents';

export const READ_MANY_TOOL: ToolContract = {
  name: READ_MANY_TOOL_NAME,
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

type ReadManyInput = z.infer<typeof ReadMultipleFilesInputSchema>;
type ReadManyOutput = z.infer<typeof ReadMultipleFilesOutputSchema>;
type ReadManyStructuredResult = ReadManyOutput;
type ReadManyStructuredResultItem = NonNullable<
  ReadManyStructuredResult['results']
>[number];
type ReadManyResult = Awaited<ReturnType<typeof readMultipleFiles>>[number];
type ReadManyTruncationReason = 'head' | 'tail' | 'range' | 'externalized';
type ReadManyResultWithResource = ReadManyResult & {
  resourceUri?: string;
  truncationReason?: ReadManyTruncationReason;
};

function buildReadManyResourceName(filePath: string): string {
  return `read:${path.basename(filePath)}`;
}

function toStructuredReadManyResult(
  result: ReadManyResultWithResource
): ReadManyStructuredResultItem {
  const structuredResult: ReadManyStructuredResultItem = {
    path: result.path,
  };

  if (result.content !== undefined) structuredResult.content = result.content;
  if (result.truncated) structuredResult.truncated = true;
  if (result.resourceUri) structuredResult.resourceUri = result.resourceUri;
  if (result.head !== undefined) structuredResult.head = result.head;
  if (result.tail !== undefined) structuredResult.tail = result.tail;
  if (result.startLine !== undefined) {
    structuredResult.startLine = result.startLine;
  }
  if (result.endLine !== undefined) structuredResult.endLine = result.endLine;
  if (result.hasMoreLines) structuredResult.hasMoreLines = true;
  if (result.totalLines !== undefined) {
    structuredResult.totalLines = result.totalLines;
  }
  if (result.linesRead !== undefined) {
    structuredResult.linesRead = result.linesRead;
  }
  if (result.truncationReason) {
    structuredResult.truncationReason = result.truncationReason;
  }
  if (result.error) structuredResult.error = result.error;

  return structuredResult;
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
    { name: buildReadManyResourceName(result.path), mimeType: 'text/plain' }
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

function buildReadManyTextSection(result: ReadManyResultWithResource): string {
  const header = `=== ${result.path} ===`;
  if (result.error) {
    return `${header}\nError: ${result.error}`;
  }

  return `${header}\n${result.content ?? ''}`;
}

function buildReadMultipleOptions(
  args: ReadManyInput,
  signal?: AbortSignal,
  onReadComplete?: () => void
): Parameters<typeof readMultipleFiles>[1] {
  const options: Parameters<typeof readMultipleFiles>[1] = {};

  if (signal) options.signal = signal;
  if (args.head !== undefined) options.head = args.head;
  if (args.tail !== undefined) options.tail = args.tail;
  if (args.startLine !== undefined) options.startLine = args.startLine;
  if (args.endLine !== undefined) options.endLine = args.endLine;
  if (onReadComplete) options.onReadComplete = onReadComplete;

  return options;
}

function buildReadManyResponsePayload(
  results: readonly ReadManyResult[],
  resourceStore?: ToolRegistrationOptions['resourceStore']
): {
  resourceLinks: ReturnType<typeof buildResourceLink>[];
  structuredResults: ReadManyStructuredResultItem[];
  summary: ReadManyStructuredResult['summary'];
  text: string;
} {
  const resourceLinks: ReturnType<typeof buildResourceLink>[] = [];
  const structuredResults: ReadManyStructuredResultItem[] = [];
  const textSections: string[] = [];
  let succeeded = 0;

  for (const result of results) {
    const mappedResult = maybeExternalizeReadManyResult(result, resourceStore);
    structuredResults.push(toStructuredReadManyResult(mappedResult));
    textSections.push(buildReadManyTextSection(mappedResult));

    if (mappedResult.resourceUri) {
      resourceLinks.push(
        buildResourceLink({
          uri: mappedResult.resourceUri,
          name: buildReadManyResourceName(mappedResult.path),
          description: FULL_FILE_CONTENTS_DESCRIPTION,
        })
      );
    }

    if (mappedResult.error === undefined) succeeded += 1;
  }

  const total = structuredResults.length;
  return {
    resourceLinks,
    structuredResults,
    summary: {
      total,
      succeeded,
      failed: total - succeeded,
    },
    text: textSections.join('\n\n'),
  };
}

async function handleReadMultipleFiles(
  args: ReadManyInput,
  signal?: AbortSignal,
  resourceStore?: ToolRegistrationOptions['resourceStore'],
  onReadComplete?: () => void
): Promise<ToolResponse<ReadManyOutput>> {
  const options = buildReadMultipleOptions(args, signal, onReadComplete);
  const results = await readMultipleFiles(args.paths, options);
  const payload = buildReadManyResponsePayload(results, resourceStore);

  const structured: ReadManyOutput = {
    ok: true,
    results: payload.structuredResults,
    summary: payload.summary,
  };

  return buildToolResponse(payload.text, structured, payload.resourceLinks);
}

export function registerReadMultipleFilesTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: ReadManyInput,
    extra: ToolExtra
  ): Promise<ToolResult<ReadManyOutput>> => {
    const primaryPath = args.paths[0] ?? '';
    return executeToolWithDiagnostics({
      toolName: READ_MANY_TOOL_NAME,
      extra,
      outputSchema: ReadMultipleFilesOutputSchema,
      timedSignal: { timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS },
      context: { path: primaryPath },
      run: async (signal) => {
        const context = buildBatchPathContext(args.paths, 'files');
        const { progress, onItemComplete } = createBatchProgressCallbacks(
          extra,
          {
            toolLabel: READ_MANY_TOOL_LABEL,
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
            `${READ_MANY_TOOL_LABEL}: ${context} • ${suffix}`,
            finalCurrent
          );
          return result;
        } catch (error) {
          progress.fail(`${READ_MANY_TOOL_LABEL}: ${context} • failed`);
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
      READ_MANY_TOOL_NAME,
      READ_MANY_TOOL,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  )
    return;
  server.registerTool(
    READ_MANY_TOOL_NAME,
    withDefaultIcons({ ...READ_MANY_TOOL }, options.iconInfo),
    validatedHandler
  );
}
