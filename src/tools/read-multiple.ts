import { basename } from 'node:path';

import type { z } from 'zod/v4';

import {
  DEFAULT_CONTINUATION_CHUNK_SIZE,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { readMultipleFiles } from '../lib/file-operations/metadata.js';
import { assignDefined } from '../lib/utils.js';
import { ReadManyInputSchema } from '../schemas/inputs.js';
import { ReadManyOutputSchema } from '../schemas/outputs.js';
import type { ContinuationSchema } from '../schemas/shared.js';

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

const FULL_FILE_CONTENTS_DESCRIPTION = 'Full file contents';

const READ_MANY_TOOL: ToolContract = {
  name: 'read_many',
  title: 'Read Multiple Files',
  description:
    'Read multiple text files in one request with contents and metadata. ' +
    'For a single file, use `read`.',
  inputSchema: ReadManyInputSchema,
  outputSchema: ReadManyOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: FILE_READ_ICONS,
  nuances: [
    'Per-file failures land in `results[].error`; the call still returns `isError:false`.',
  ],
  gotchas: [
    'One `defaultTimeoutMs` covers the whole batch — slow disks may starve later files.',
  ],
  taskSupport: 'optional',
  defaultTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
} as const;

const READ_MANY_TOOL_LABEL = READ_MANY_TOOL.title;

type ReadManyInput = z.infer<typeof ReadManyInputSchema>;
type ReadManyOutput = z.infer<typeof ReadManyOutputSchema>;
type ReadManyOutputItem = NonNullable<ReadManyOutput['results']>[number];
type ReadManyResult = Awaited<ReturnType<typeof readMultipleFiles>>[number];
type ReadManyResultWithResource = Omit<ReadManyResult, 'error'> & {
  error?: ReadManyOutputItem['error'];
  resourceUri?: string;
  expiresAt?: string;
};

function buildReadManyResourceName(filePath: string): string {
  return `read:${basename(filePath)}`;
}

function buildReadContinuation(result: {
  path: string;
  hasMoreLines?: boolean;
  linesRead?: number;
  startLine?: number;
  endLine?: number;
  head?: number;
  totalLines?: number;
}): z.infer<typeof ContinuationSchema> | undefined {
  if (!result.hasMoreLines) return undefined;
  const linesRead = result.linesRead ?? 0;
  const nextStart = (result.startLine ?? 1) + linesRead;
  let chunkSize: number;
  if (result.head !== undefined) {
    chunkSize = result.head;
  } else if (result.startLine !== undefined && result.endLine !== undefined) {
    chunkSize = result.endLine - result.startLine + 1;
  } else {
    chunkSize = DEFAULT_CONTINUATION_CHUNK_SIZE;
  }
  const nextEnd = nextStart + chunkSize - 1;
  const hint = result.totalLines
    ? `${result.totalLines - nextStart + 1} lines remain (${nextStart}–${result.totalLines}). Read next chunk with these args.`
    : 'File was truncated. Read next chunk with these args.';
  return {
    tool: 'read',
    args: { path: result.path, startLine: nextStart, endLine: nextEnd },
    hint,
  };
}

function toStructuredReadManyResult(
  result: ReadManyResultWithResource
): ReadManyOutputItem {
  const structuredResult: ReadManyOutputItem = {
    path: result.path,
  };

  return assignDefined(structuredResult, {
    content: result.content,
    resourceUri: result.resourceUri,
    head: result.head,
    tail: result.tail,
    startLine: result.startLine,
    endLine: result.endLine,
    hasMoreLines: result.hasMoreLines ? true : undefined,
    totalLines: result.totalLines,
    linesRead: result.linesRead,
    continuation: buildReadContinuation(result),
    error: result.error,
  });
}

function maybeExternalizeReadManyResult(
  result: ReadManyResult,
  resourceStore?: ToolRegistrationOptions['resourceStore']
): ReadManyResultWithResource {
  const { error, ...rest } = result;
  const baseResult: ReadManyResultWithResource = {
    ...rest,
    ...(error
      ? { error: buildStructuredError(error, ErrorCode.UNKNOWN, result.path) }
      : {}),
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
    resourceUri: externalized.entry.uri,
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

  return assignDefined(options, {
    signal,
    head: args.head,
    tail: args.tail,
    startLine: args.startLine,
    endLine: args.endLine,
    onReadComplete,
  });
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
