import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { applyPatch, formatPatch, parsePatch, type StructuredPatch } from 'diff';
import { z } from 'zod/v4';

import { withAbort } from '../core/abort.js';
import { atomicWriteFile } from '../core/atomic-write.js';
import { MAX_TEXT_FILE_SIZE, PARALLEL_CONCURRENCY } from '../core/constants.js';
import { ErrorCode, McpError } from '../core/errors.js';
import { readFileWithStats } from '../core/file-content.js';
import { Logger } from '../core/logger.js';
import { detectMimeType } from '../core/mime.js';
import { processInParallel } from '../core/parallel.js';
import type { PathGuard } from '../core/path-guard.js';
import type { ResourceStore } from '../core/store.js';
import { runInWorker, shouldOffload } from '../core/worker-pool.js';
import { NonNegInt, OptionalPath } from '../schemas/fields.js';
import {
  defaultFalseBoolean,
  OperationSummarySchema,
  PerFileErrorSchema,
} from '../schemas/shared.js';

import { formatBytes } from '../config.js';
import { defineTool } from './define-tool.js';
import { FILE_EDIT_ICONS } from './icons.js';
import {
  buildResourceResponse,
  buildStructuredError,
  buildToolErrorResponse,
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  putResource,
  type ToolContract,
  type ToolResult,
} from './shared.js';

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

const APPLY_PATCH_TOOL: ToolContract = {
  name: 'apply_patch',
  title: 'Apply Patch',
  description:
    'Apply a unified diff patch to one or more files. ' +
    'Failures are reported per-file via isError:true. ' +
    'Workflow: `diff_files` → `apply_patch(dryRun:true)` → `apply_patch`. ' +
    'On failure, regenerate the patch from current file content.',
  inputSchema: ApplyPatchInputSchema,
  outputSchema: ApplyPatchOutputSchema,
  annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  icons: FILE_EDIT_ICONS,
  nuances: ['Multi-file patches use `path` as base directory; per-file results in `files[]`.'],
  taskSupport: 'optional',
} as const;

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
): Promise<ToolResult<z.infer<typeof ApplyPatchOutputSchema>>> {
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
    return buildToolErrorResponse(
      new McpError(
        ErrorCode.INVALID_INPUT,
        `All ${parsed.length} patches failed${label}. Files: ${failedPaths}. Regenerate via diff_files.`,
      ),
      ErrorCode.INVALID_INPUT,
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
  if (!options.dryRun && resourceStore && primaryResult) {
    const { entry } = putResource({
      store: resourceStore,
      name: basename(primaryResult.path),
      mimeType: mimeInfo.mimeType,
      kind: mimeInfo.kind,
      content: patchedContent,
    });
    resourceUri = entry.uri;
  }

  const filesPatched = results.filter((r) => r.applied).map((r) => r.path);
  const summary = [
    `apply-patch: patched ${succeeded} file(s)`,
    primaryResult ? basename(primaryResult.path) : 'file',
    formatBytes(bytesWritten),
  ].join(' · ');

  const link = {
    type: 'resource_link' as const,
    uri: resourceUri,
    name: primaryResult ? basename(primaryResult.path) : 'patched-file',
    mimeType: mimeInfo.mimeType,
    size: bytesWritten,
    annotations: {
      audience: ['user' as const],
    },
  };

  return buildResourceResponse({
    summary,
    resources: [link],
    structured: {
      ok: true,
      path: primaryResult?.path,
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
    },
  });
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
): Promise<ToolResult<z.infer<typeof ApplyPatchOutputSchema>>> {
  // diff cannot be undefined here if we got past validation, but TS checking is permissive
  let result: PatchFileResult;
  try {
    result = await applyDiff(targetPath, diff, options, pathGuard, signal);
  } catch (error) {
    return buildToolErrorResponse(error, ErrorCode.UNKNOWN, targetPath);
  }

  if (!result.applied) {
    return buildToolErrorResponse(
      new McpError(
        ErrorCode.INVALID_INPUT,
        'Patch failed or had no effect. Content may have changed. Regenerate via diff_files.',
      ),
      ErrorCode.INVALID_INPUT,
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
  if (!options.dryRun && resourceStore) {
    const { entry } = putResource({
      store: resourceStore,
      name: basename(result.path),
      mimeType: mimeInfo.mimeType,
      kind: mimeInfo.kind,
      content: patchedContent,
    });
    resourceUri = entry.uri;
  }

  const summary = [
    'apply-patch: patched 1 file(s)',
    basename(result.path),
    formatBytes(bytesWritten),
  ].join(' · ');

  const link = {
    type: 'resource_link' as const,
    uri: resourceUri,
    name: basename(result.path),
    mimeType: mimeInfo.mimeType,
    size: bytesWritten,
    annotations: {
      audience: ['user' as const],
    },
  };

  return buildResourceResponse({
    summary,
    resources: [link],
    structured: {
      ok: true,
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
    },
  });
}

async function handleApplyPatch(
  args: z.infer<typeof ApplyPatchInputSchema>,
  pathGuard: PathGuard,
  resourceStore: ResourceStore | undefined,
  signal?: AbortSignal,
): Promise<ToolResult<z.infer<typeof ApplyPatchOutputSchema>>> {
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
type PatchOutput = z.infer<typeof ApplyPatchOutputSchema>;

export const APPLY_PATCH = defineTool<PatchInput, PatchOutput>({
  contract: APPLY_PATCH_TOOL,
  defaultErrorCode: ErrorCode.UNKNOWN,
  run: async (args, ctx) => {
    const result = await handleApplyPatch(args, ctx.pathGuard, ctx.resourceStore, ctx.signal);
    if (!result.isError && !args.dryRun) {
      const sc = result.structuredContent;
      const added = sc.files.reduce((s, f) => s + (f.linesAdded ?? 0), 0);
      const removed = sc.files.reduce((s, f) => s + (f.linesRemoved ?? 0), 0);
      void ctx.log?.(
        'info',
        `patch: ${args.path ?? ''} (+${String(added)}/-${String(removed)})`,
        'apply_patch',
      );
    }
    return result;
  },
  progressMessage: (args) => {
    const name = basename(args.path ?? '');
    return args.dryRun
      ? `${APPLY_PATCH_TOOL.title}: ${name} [dry run]`
      : `${APPLY_PATCH_TOOL.title}: ${name}`;
  },
  completionMessage: (args: PatchInput, result: ToolResult<PatchOutput>): string => {
    const name = basename(args.path ?? '');
    if (result.isError) return `${APPLY_PATCH_TOOL.title}: ${name} • ${result.errorCode}`;
    const sc = result.structuredContent;
    const added = sc.files.reduce((s, f) => s + (f.linesAdded ?? 0), 0);
    const removed = sc.files.reduce((s, f) => s + (f.linesRemoved ?? 0), 0);
    const dry = args.dryRun ? 'dry run ' : '';
    if (added > 0 || removed > 0)
      return `${APPLY_PATCH_TOOL.title}: ${name} • ${dry}+${added} -${removed}`;
    return `${APPLY_PATCH_TOOL.title}: ${name} • ${dry}no changes`;
  },
});
