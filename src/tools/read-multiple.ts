import { basename } from 'node:path';

import type { z } from 'zod/v4';

import { DEFAULT_SEARCH_TIMEOUT_MS } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { readMultipleFiles } from '../lib/file-operations/metadata.js';
import { ReadManyInputSchema } from '../schemas/inputs.js';
import { ReadManyOutputSchema } from '../schemas/outputs.js';

import { defineTool } from './define-tool.js';
import { FILE_READ_ICONS } from './icons.js';
import {
  buildBatchPathContext,
  buildResourceLink,
  buildStructuredError,
  buildToolResponse,
  completeProgressSession,
  createBatchProgressCallbacks,
  maybeExternalizeTextContent,
  READ_ONLY_TOOL_ANNOTATIONS,
  resolveFinalProgressCurrent,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResponse,
} from './shared.js';
import { reportTaskStatus } from './task-support.js';

const READ_MANY_TOOL_NAME = 'read_many';
const FULL_FILE_CONTENTS_DESCRIPTION = 'Full file contents';

const READ_MANY_TOOL: ToolContract = {
  name: READ_MANY_TOOL_NAME,
  title: 'Read Multiple Files',
  description:
    'Read multiple text files in one request with contents and metadata. ' +
    'For a single file, use `read`.',
  inputSchema: ReadManyInputSchema,
  outputSchema: ReadManyOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: FILE_READ_ICONS,
  taskSupport: 'optional',
  defaultTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
} as const;

const READ_MANY_TOOL_LABEL = READ_MANY_TOOL.title;

type ReadManyInput = z.infer<typeof ReadManyInputSchema>;
type ReadManyOutput = z.infer<typeof ReadManyOutputSchema>;
type ReadManyOutputItem = NonNullable<ReadManyOutput['results']>[number];
type ReadManyResult = Awaited<ReturnType<typeof readMultipleFiles>>[number];
type ReadManyTruncationReason = 'head' | 'tail' | 'range' | 'externalized';
type ReadManyResultWithResource = Omit<ReadManyResult, 'error'> & {
  error?: ReadManyOutputItem['error'];
  resourceUri?: string;
  truncationReason?: ReadManyTruncationReason;
  expiresAt?: string;
};

function buildReadManyResourceName(filePath: string): string {
  return `read:${basename(filePath)}`;
}

function toStructuredReadManyResult(
  result: ReadManyResultWithResource
): ReadManyOutputItem {
  const structuredResult: ReadManyOutputItem = {
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
  const { error, ...rest } = result;
  const baseResult: ReadManyResultWithResource = {
    ...rest,
    ...(error
      ? { error: buildStructuredError(error, ErrorCode.UNKNOWN, result.path) }
      : {}),
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
    expiresAt: externalized.entry.expiresAt,
  };
}

function buildReadManyTextSection(result: ReadManyResultWithResource): string {
  const header = `=== ${result.path} ===`;
  if (result.error) {
    return `${header}\nError [${result.error.code}]: ${result.error.message}`;
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
  structuredResults: ReadManyOutputItem[];
  summary: ReadManyOutput['summary'];
  text: string;
} {
  const resourceLinks: ReturnType<typeof buildResourceLink>[] = [];
  const structuredResults: ReadManyOutputItem[] = [];
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
          ...(mappedResult.expiresAt
            ? { expiresAt: mappedResult.expiresAt }
            : {}),
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

export const READ_MANY = defineTool<ReadManyInput, ReadManyOutput>({
  contract: READ_MANY_TOOL,
  defaultErrorCode: ErrorCode.NOT_FILE,
  diagnosticsContext: (args) => ({ path: args.paths[0] ?? '' }),
  run: async (args, ctx) => {
    const context = buildBatchPathContext(args.paths, 'files');
    const label = `${READ_MANY_TOOL_LABEL}: ${context}`;
    const { progress, onItemComplete: rawOnItemComplete } =
      createBatchProgressCallbacks(ctx, {
        toolLabel: READ_MANY_TOOL_LABEL,
        context,
        totalItems: args.paths.length,
        itemVerb: 'read',
      });

    let itemsDone = 0;
    const onItemComplete = (): void => {
      rawOnItemComplete();
      itemsDone++;
      void reportTaskStatus(
        `${label} [${itemsDone}/${args.paths.length} read]`
      );
    };

    return completeProgressSession(progress, label, async () => {
      const result = await handleReadMultipleFiles(
        args,
        ctx.signal,
        ctx.resourceStore,
        onItemComplete
      );

      const sc = result.structuredContent;
      const total = sc.summary.total;
      const failed = sc.summary.failed;
      const suffix = failed ? `${failed} failed` : 'done';
      const finalCurrent = resolveFinalProgressCurrent(progress, total);
      return { value: result, suffix, finalCurrent };
    });
  },
});
