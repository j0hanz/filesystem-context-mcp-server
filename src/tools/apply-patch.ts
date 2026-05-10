import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { applyPatch, formatPatch, parsePatch, type StructuredPatch } from 'diff';
import { z } from 'zod/v4';

import { processInParallel, runInWorker, shouldOffload, withAbort } from '../core/concurrency.js';
import { ErrorCode, McpError } from '../core/errors.js';
import { atomicWriteFile, detectMimeType, readFileWithStats } from '../core/fs.js';
import { Logger } from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { MAX_TEXT_FILE_SIZE, PARALLEL_CONCURRENCY } from '../core/util.js';
import {
  defaultFalseBoolean,
  NonNegInt,
  OperationSummarySchema,
  OptionalPath,
  PerFileErrorSchema,
} from '../schema.js';
import {
  buildResourceResponse,
  buildStructuredError,
  buildToolResponse,
  formatBytes,
  putResource,
} from './_helpers.js';
import { defineTool } from './define.js';

const ApplyPatchInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'Required for single-file patches without a/ b/ headers; ignored for multi-file patches',
  ),
  patch: z
    .string()
    .min(1)
    .max(MAX_TEXT_FILE_SIZE)
    .describe('Unified diff patch content (unified format with --- a/ +++ b/ headers)')
    .meta({
      examples: [
        '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,3 @@\n-const x = 1;\n+const x = 2;\n',
      ],
    }),
  dryRun: defaultFalseBoolean('Validate patch without applying'),
  fuzzFactor: z
    .int32()
    .min(0)
    .max(10)
    .optional()
    .default(0)
    .describe('Lines of context allowed to differ (0\u201310)'),
  autoConvertLineEndings: defaultFalseBoolean('Auto-convert line endings'),
});

const ApplyPatchOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  path: z.string().optional().describe('Primary patched file path'),
  size: NonNegInt.optional().describe('Primary file size in bytes'),
  lineCount: NonNegInt.optional().describe('Primary file line count'),
  mimeType: z.string().optional().describe('MIME type of primary file'),
  kind: z
    .enum(['text', 'binary', 'image', 'audio', 'pdf'])
    .optional()
    .describe('File kind of primary file'),
  resourceUri: z.string().optional().describe('Resource URI for primary file'),
  files: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        hunks: NonNegInt.describe('Hunks applied'),
        linesAdded: NonNegInt.optional().describe('Lines added'),
        linesRemoved: NonNegInt.optional().describe('Lines removed'),
      }),
    )
    .describe('Per-file patch results'),
  appliedHunks: NonNegInt.optional().describe('Total hunks applied (primary file)'),
  rejectedHunks: NonNegInt.optional().describe('Total hunks rejected (primary file)'),
  filesPatched: z.array(z.string()).optional().describe('List of patched file paths'),
  summary: OperationSummarySchema.describe('Operation summary'),
  failures: z
    .array(
      z.strictObject({
        path: z.string(),
        error: PerFileErrorSchema,
      }),
    )
    .optional()
    .describe('Per-file patch failures'),
});

function assertPatchTargetSizeWithinLimit(
  filePath: string,
  size: number,
  maxFileSize: number,
): void {
  if (size <= maxFileSize) return;
  throw new McpError(
    ErrorCode.TOO_LARGE,
    `File too large for patch (${size} bytes > ${maxFileSize} bytes).`,
    filePath,
    { size, maxFileSize },
  );
}

function countStructuredPatchStats(diff: StructuredPatch): {
  hunksApplied: number;
  linesAdded: number;
  linesRemoved: number;
} {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) linesAdded++;
      else if (line.startsWith('-')) linesRemoved++;
    }
  }
  return { hunksApplied: diff.hunks.length, linesAdded, linesRemoved };
}

function stripGitPrefix(fileName: string): string {
  return fileName.startsWith('a/') || fileName.startsWith('b/') ? fileName.slice(2) : fileName;
}

function extractPatchTargetPath(diff: StructuredPatch): string | undefined {
  if (diff.newFileName) return stripGitPrefix(diff.newFileName);
  if (diff.oldFileName) return stripGitPrefix(diff.oldFileName);
  return undefined;
}

type PatchFileResult =
  | {
      path: string;
      applied: true;
      content: string;
      hunksApplied: number;
      linesAdded: number;
      linesRemoved: number;
    }
  | {
      path: string;
      applied: false;
      error: {
        code: string;
        message: string;
        path?: string;
        suggestion?: string;
      };
    };

interface PatchOptions {
  dryRun: boolean;
  fuzzFactor: number;
  autoConvertLineEndings: boolean;
}

async function applyDiff(
  filePath: string,
  diff: StructuredPatch,
  options: PatchOptions,
  pathGuard: PathGuard,
  signal?: AbortSignal,
): Promise<PatchFileResult> {
  const validPath = await pathGuard.validateExistingPath(filePath);
  pathGuard.assertAllowedFileAccess(filePath);

  const fileStats = await withAbort(stat(validPath), signal);
  assertPatchTargetSizeWithinLimit(validPath, fileStats.size, MAX_TEXT_FILE_SIZE);

  const { content } = await readFileWithStats(
    filePath,
    validPath,
    fileStats,
    {
      encoding: 'utf-8',
      maxSize: MAX_TEXT_FILE_SIZE,
      skipBinary: true,
      ...(signal ? { signal } : {}),
    },
    pathGuard,
  );

  const patched = await (async (): Promise<string | false> => {
    const patchText = formatPatch(diff);
    const totalBytes = content.length + patchText.length;
    if (shouldOffload(totalBytes)) {
      const result = await runInWorker(
        'applyPatch',
        {
          source: content,
          patchText,
          fuzzFactor: options.fuzzFactor,
          autoConvertLineEndings: options.autoConvertLineEndings,
        },
        signal ? { signal } : {},
      );
      return result.applied;
    }
    return applyPatch(content, diff, {
      fuzzFactor: options.fuzzFactor,
      autoConvertLineEndings: options.autoConvertLineEndings,
    });
  })();

  if (patched === false) {
    return {
      path: validPath,
      applied: false,
      error: {
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Patch conflicts or had no effect.',
      },
    };
  }
  if (patched === content) {
    return {
      path: validPath,
      applied: false,
      error: {
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Patch was empty or redundant.',
      },
    };
  }

  const patchStats = countStructuredPatchStats(diff);

  if (!options.dryRun) {
    await atomicWriteFile(validPath, patched, { encoding: 'utf-8', signal });
  }

  return {
    path: validPath,
    content: patched,
    applied: true,
    ...patchStats,
  };
}

type OutputFiles = z.infer<typeof ApplyPatchOutputSchema>['files'];

async function processMultiFilePatch(
  basePath: string,
  parsed: StructuredPatch[],
  options: PatchOptions,
  pathGuard: PathGuard,
  resourceStore: ResourceStore | undefined,
  signal?: AbortSignal,
): Promise<{
  structured: z.infer<typeof ApplyPatchOutputSchema>;
  link?: ReturnType<typeof putResource>['link'];
}> {
  const validBase = await pathGuard.validateExistingPath(basePath);

  const tasks = parsed.map((diff) => {
    const fileName = extractPatchTargetPath(diff);
    if (!fileName) {
      return (): Promise<PatchFileResult> =>
        Promise.resolve({
          path: '<unknown>',
          applied: false,
          error: {
            code: ErrorCode.INVALID_INPUT,
            message: 'Could not extract target path',
          },
        });
    }
    const filePath = resolve(validBase, fileName);
    return async (): Promise<PatchFileResult> => {
      try {
        const r = await applyDiff(filePath, diff, options, pathGuard, signal);
        return { ...r, path: fileName };
      } catch (error) {
        return {
          path: fileName,
          applied: false,
          error: buildStructuredError(error, ErrorCode.UNKNOWN, filePath),
        };
      }
    };
  });

  const { results } = await processInParallel(
    tasks,
    (task) => task(),
    PARALLEL_CONCURRENCY,
    signal,
  );

  const succeeded = results.filter((r) => r.applied).length;
  const label = options.dryRun ? ' (dry run)' : '';

  if (succeeded === 0) {
    const failedPaths = results.map((r) => r.path).join(', ');
    throw new McpError(
      ErrorCode.INVALID_INPUT,
      `All ${parsed.length} patches failed${label}. Files: ${failedPaths}. Regenerate via diff_files.`,
    );
  }

  const files: OutputFiles = results.flatMap((r) =>
    r.applied
      ? [
          {
            path: r.path,
            hunks: r.hunksApplied,
            linesAdded: r.linesAdded,
            linesRemoved: r.linesRemoved,
          },
        ]
      : [],
  );

  const failures = results.flatMap((r) => (!r.applied ? [{ path: r.path, error: r.error }] : []));

  if (!options.dryRun) {
    const added = files.reduce((s, f) => s + (f.linesAdded ?? 0), 0);
    const removed = files.reduce((s, f) => s + (f.linesRemoved ?? 0), 0);
    Logger.info(`apply_patch: ${basePath} (${succeeded} file(s), +${added}/-${removed})`);
  }

  // Get primary (first patched) file for resource storage
  const primaryResult = results.find((r) => r.applied);
  const patchedContent = primaryResult?.content ?? '';
  const bytesWritten = Buffer.byteLength(patchedContent, 'utf-8');
  const lineCount = patchedContent.split('\n').length;
  const mimeInfo = primaryResult
    ? detectMimeType(primaryResult.path, Buffer.from(patchedContent.slice(0, 512)))
    : { mimeType: 'text/plain', kind: 'text' as const };

  let resourceUri = '';
  let resourceLink: ReturnType<typeof putResource>['link'] | undefined;
  if (!options.dryRun && resourceStore && primaryResult) {
    const { entry, link } = putResource({
      store: resourceStore,
      name: basename(primaryResult.path),
      mimeType: mimeInfo.mimeType,
      kind: mimeInfo.kind,
      content: patchedContent,
    });
    resourceUri = entry.uri;
    resourceLink = link;
  }

  const filesPatched = results.filter((r) => r.applied).map((r) => r.path);

  const structured: z.infer<typeof ApplyPatchOutputSchema> = {
    ok: true as const,
    ...(primaryResult ? { path: primaryResult.path } : {}),
    size: bytesWritten,
    lineCount,
    mimeType: mimeInfo.mimeType,
    kind: mimeInfo.kind,
    resourceUri,
    files,
    appliedHunks: primaryResult?.hunksApplied ?? 0,
    rejectedHunks: 0,
    filesPatched,
    summary: {
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
    },
    ...(failures.length > 0 ? { failures } : {}),
  };
  return { structured, ...(resourceLink ? { link: resourceLink } : {}) };
}

function parseAndValidatePatch(patch: string): ReturnType<typeof parsePatch> {
  if (!patch.trim()) {
    throw new McpError(ErrorCode.INVALID_INPUT, 'Patch content is empty.');
  }

  const parsed = parsePatch(patch);

  const hasHunks = parsed.some((p) => p.hunks.length > 0);
  if (!hasHunks) {
    throw new McpError(
      ErrorCode.INVALID_INPUT,
      'Patch must include unified hunk headers (@@ -n,n +n,n @@).',
    );
  }

  return parsed;
}

async function handleSingleFilePatch(
  targetPath: string,
  diff: ReturnType<typeof parsePatch>[number],
  options: PatchOptions,
  pathGuard: PathGuard,
  resourceStore: ResourceStore | undefined,
  signal?: AbortSignal,
): Promise<{
  structured: z.infer<typeof ApplyPatchOutputSchema>;
  link?: ReturnType<typeof putResource>['link'];
}> {
  // diff cannot be undefined here if we got past validation, but TS checking is permissive
  let result: PatchFileResult;
  try {
    result = await applyDiff(targetPath, diff, options, pathGuard, signal);
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(
      ErrorCode.UNKNOWN,
      error instanceof Error ? error.message : String(error),
      targetPath,
    );
  }

  if (!result.applied) {
    throw new McpError(
      ErrorCode.INVALID_INPUT,
      'Patch failed or had no effect. Content may have changed. Regenerate via diff_files.',
      targetPath,
    );
  }

  if (!options.dryRun) {
    Logger.info(`apply_patch: ${targetPath} (+${result.linesAdded}/-${result.linesRemoved})`);
  }

  // Store patched content in resource store if available
  const patchedContent = result.content;
  const bytesWritten = Buffer.byteLength(patchedContent, 'utf-8');
  const lineCount = patchedContent.split('\n').length;
  const mimeInfo = detectMimeType(result.path, Buffer.from(patchedContent.slice(0, 512)));

  let resourceUri = '';
  let resourceLink: ReturnType<typeof putResource>['link'] | undefined;
  if (!options.dryRun && resourceStore) {
    const { entry, link } = putResource({
      store: resourceStore,
      name: basename(result.path),
      mimeType: mimeInfo.mimeType,
      kind: mimeInfo.kind,
      content: patchedContent,
    });
    resourceUri = entry.uri;
    resourceLink = link;
  }

  const structured: z.infer<typeof ApplyPatchOutputSchema> = {
    ok: true as const,
    path: result.path,
    size: bytesWritten,
    lineCount,
    mimeType: mimeInfo.mimeType,
    kind: mimeInfo.kind,
    resourceUri,
    files: [
      {
        path: result.path,
        hunks: result.hunksApplied,
        linesAdded: result.linesAdded,
        linesRemoved: result.linesRemoved,
      },
    ],
    appliedHunks: result.hunksApplied,
    rejectedHunks: 0,
    filesPatched: [result.path],
    summary: { total: 1, succeeded: 1, failed: 0 },
  };
  return { structured, ...(resourceLink ? { link: resourceLink } : {}) };
}

async function handleApplyPatch(
  args: z.infer<typeof ApplyPatchInputSchema>,
  pathGuard: PathGuard,
  resourceStore: ResourceStore | undefined,
  signal?: AbortSignal,
): Promise<{
  structured: z.infer<typeof ApplyPatchOutputSchema>;
  link?: ReturnType<typeof putResource>['link'];
}> {
  const parsed = parseAndValidatePatch(args.patch);

  const options: PatchOptions = {
    dryRun: args.dryRun,
    fuzzFactor: args.fuzzFactor,
    autoConvertLineEndings: args.autoConvertLineEndings,
  };

  const targetPath = args.path ?? '';

  if (parsed.length > 1) {
    return processMultiFilePatch(targetPath, parsed, options, pathGuard, resourceStore, signal);
  }

  const diff = parsed[0];
  if (!diff) {
    throw new McpError(ErrorCode.INVALID_INPUT, 'No patch content found.');
  }

  return handleSingleFilePatch(targetPath, diff, options, pathGuard, resourceStore, signal);
}

type PatchInput = z.infer<typeof ApplyPatchInputSchema>;

export const APPLY_PATCH = defineTool({
  name: 'apply_patch',
  title: 'Apply Patch',
  description:
    'Apply a unified diff patch to one or more files. ' +
    'Failures are reported per-file via isError:true. ' +
    'Workflow: `diff_files` → `apply_patch(dryRun:true)` → `apply_patch`. ' +
    'On failure, regenerate the patch from current file content.',
  input: ApplyPatchInputSchema,
  output: ApplyPatchOutputSchema,
  annotations: 'destructiveWrite',
  task: 'optional',
  nuances: ['Multi-file patches use `path` as base directory; per-file results in `files[]`.'],
  defaultErrorCode: ErrorCode.UNKNOWN,
  progressLabel: (args: PatchInput) => {
    const name = basename(args.path ?? '');
    return args.dryRun ? `Apply Patch: ${name} [dry run]` : `Apply Patch: ${name}`;
  },
  run: async (args, ctx) => {
    const { structured, link } = await handleApplyPatch(
      args,
      ctx.pathGuard,
      ctx.resourceStore,
      ctx.signal,
    );
    if (!args.dryRun) {
      const added = structured.files.reduce((s, f) => s + (f.linesAdded ?? 0), 0);
      const removed = structured.files.reduce((s, f) => s + (f.linesRemoved ?? 0), 0);
      ctx.log?.(
        'info',
        `patch: ${args.path ?? ''} (+${String(added)}/-${String(removed)})`,
        'apply_patch',
      );
    }
    const succeeded = structured.summary.succeeded;
    const fileWord = succeeded === 1 ? 'file' : 'files';
    const baseSummary =
      `apply-patch: patched ${String(succeeded)} ${fileWord}` +
      (structured.path ? ` \u00b7 ${basename(structured.path)}` : '') +
      ` \u00b7 ${formatBytes(structured.size ?? 0)}`;
    if (link) {
      return buildResourceResponse({
        summary: baseSummary,
        resources: [link],
        structured,
      });
    }
    return buildToolResponse(baseSummary, structured);
  },
});
