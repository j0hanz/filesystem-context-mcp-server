import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import {
  applyPatch,
  formatPatch,
  parsePatch,
  type StructuredPatch,
} from 'diff';
import type { z } from 'zod/v4';

import { withAbort } from '../lib/abort.js';
import { atomicWriteFile } from '../lib/atomic-write.js';
import { MAX_TEXT_FILE_SIZE, PARALLEL_CONCURRENCY } from '../lib/constants.js';
import { ErrorCode, McpError } from '../lib/errors.js';
import { readFileWithStats } from '../lib/file-content.js';
import { Logger } from '../lib/logger.js';
import { processInParallel } from '../lib/parallel.js';
import { assertAllowedFileAccess, validateExistingPath } from '../lib/paths.js';
import { runInWorker, shouldOffload } from '../lib/worker-pool.js';
import { ApplyPatchInputSchema } from '../schemas/inputs.js';
import { ApplyPatchOutputSchema } from '../schemas/outputs.js';

import { defineTool } from './define-tool.js';
import { FILE_EDIT_ICONS } from './icons.js';
import {
  buildStructuredError,
  buildToolErrorResponse,
  buildToolResponse,
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  type ToolContract,
  type ToolResult,
} from './shared.js';

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
  nuances: [
    'Multi-file patches use `path` as base directory; per-file results in `files[]`.',
  ],
  taskSupport: 'optional',
} as const;

function assertPatchTargetSizeWithinLimit(
  filePath: string,
  size: number,
  maxFileSize: number
): void {
  if (size <= maxFileSize) return;
  throw new McpError(
    ErrorCode.TOO_LARGE,
    `File too large for patch (${size} bytes > ${maxFileSize} bytes).`,
    filePath,
    { size, maxFileSize }
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
  return fileName.startsWith('a/') || fileName.startsWith('b/')
    ? fileName.slice(2)
    : fileName;
}

function extractPatchTargetPath(diff: StructuredPatch): string | undefined {
  if (diff.newFileName) return stripGitPrefix(diff.newFileName);
  if (diff.oldFileName) return stripGitPrefix(diff.oldFileName);
  return undefined;
}

interface PatchFileResult {
  path: string;
  applied: boolean;
  hunksApplied?: number;
  linesAdded?: number;
  linesRemoved?: number;
  error?: { code: string; message: string; path?: string; suggestion?: string };
}

interface PatchOptions {
  dryRun: boolean;
  fuzzFactor: number;
  autoConvertLineEndings: boolean;
}

async function applyDiff(
  filePath: string,
  diff: StructuredPatch,
  options: PatchOptions,
  signal?: AbortSignal
): Promise<PatchFileResult> {
  const validPath = await validateExistingPath(filePath, signal);
  assertAllowedFileAccess(filePath, validPath);

  const fileStats = await withAbort(stat(validPath), signal);
  assertPatchTargetSizeWithinLimit(
    validPath,
    fileStats.size,
    MAX_TEXT_FILE_SIZE
  );

  const { content } = await readFileWithStats(filePath, validPath, fileStats, {
    encoding: 'utf-8',
    maxSize: MAX_TEXT_FILE_SIZE,
    skipBinary: true,
    ...(signal ? { signal } : {}),
  });

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
        signal ? { signal } : {}
      );
      return result.applied;
    }
    return applyPatch(content, diff, {
      fuzzFactor: options.fuzzFactor,
      autoConvertLineEndings: options.autoConvertLineEndings,
    });
  })();

  if (patched === false) {
    return { path: validPath, applied: false };
  }
  if (patched === content) {
    return { path: validPath, applied: false };
  }

  const patchStats = countStructuredPatchStats(diff);

  if (!options.dryRun) {
    await atomicWriteFile(validPath, patched, { encoding: 'utf-8', signal });
  }

  return { path: validPath, applied: true, ...patchStats };
}

type OutputFiles = z.infer<typeof ApplyPatchOutputSchema>['files'];

async function processMultiFilePatch(
  basePath: string,
  parsed: StructuredPatch[],
  options: PatchOptions,
  signal?: AbortSignal
): Promise<ToolResult<z.infer<typeof ApplyPatchOutputSchema>>> {
  const validBase = await validateExistingPath(basePath, signal);

  const tasks = parsed.map((diff) => {
    const fileName = extractPatchTargetPath(diff);
    if (!fileName) {
      return (): Promise<PatchFileResult> =>
        Promise.resolve({ path: '<unknown>', applied: false });
    }
    const filePath = resolve(validBase, fileName);
    return async (): Promise<PatchFileResult> => {
      try {
        const r = await applyDiff(filePath, diff, options, signal);
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
    signal
  );

  const succeeded = results.filter((r) => r.applied).length;
  const label = options.dryRun ? ' (dry run)' : '';

  if (succeeded === 0) {
    const failedPaths = results.map((r) => r.path).join(', ');
    return buildToolErrorResponse(
      new McpError(
        ErrorCode.INVALID_INPUT,
        `All ${parsed.length} patches failed${label}. Files: ${failedPaths}. Regenerate via diff_files.`
      ),
      ErrorCode.INVALID_INPUT
    );
  }

  const files: OutputFiles = results
    .filter((r) => r.applied)
    .map((r) => ({
      path: r.path,
      hunks: r.hunksApplied ?? 0,
      ...(r.linesAdded !== undefined ? { linesAdded: r.linesAdded } : {}),
      ...(r.linesRemoved !== undefined ? { linesRemoved: r.linesRemoved } : {}),
    }));

  const failures = results
    .filter(
      (r): r is typeof r & { error: NonNullable<typeof r.error> } =>
        !r.applied && r.error !== undefined
    )
    .map((r) => ({ path: r.path, error: r.error }));

  if (!options.dryRun) {
    const added = files.reduce((s, f) => s + (f.linesAdded ?? 0), 0);
    const removed = files.reduce((s, f) => s + (f.linesRemoved ?? 0), 0);
    Logger.info(
      `apply_patch: ${basePath} (${succeeded} file(s), +${added}/-${removed})`
    );
  }

  return buildToolResponse(
    `Applied ${succeeded}/${parsed.length} file patches${label}`,
    {
      ok: true,
      files,
      summary: {
        total: results.length,
        succeeded,
        failed: results.length - succeeded,
      },
      ...(failures.length > 0 ? { failures } : {}),
    }
  );
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
      'Patch must include unified hunk headers (@@ -n,n +n,n @@).'
    );
  }

  return parsed;
}

async function handleSingleFilePatch(
  targetPath: string,
  diff: ReturnType<typeof parsePatch>[number],
  options: PatchOptions,
  signal?: AbortSignal
): Promise<ToolResult<z.infer<typeof ApplyPatchOutputSchema>>> {
  // diff cannot be undefined here if we got past validation, but TS checking is permissive
  let result: PatchFileResult;
  try {
    result = await applyDiff(targetPath, diff, options, signal);
  } catch (error) {
    return buildToolErrorResponse(error, ErrorCode.UNKNOWN, targetPath);
  }

  if (!result.applied) {
    return buildToolErrorResponse(
      new McpError(
        ErrorCode.INVALID_INPUT,
        'Patch failed or had no effect. Content may have changed. Regenerate via diff_files.'
      ),
      ErrorCode.INVALID_INPUT,
      targetPath
    );
  }

  const text = options.dryRun
    ? 'Dry run successful. Patch can be applied.'
    : `Successfully patched ${targetPath}`;

  if (!options.dryRun) {
    Logger.info(
      `apply_patch: ${targetPath} (+${result.linesAdded ?? 0}/-${result.linesRemoved ?? 0})`
    );
  }

  return buildToolResponse(text, {
    ok: true,
    files: [
      {
        path: result.path,
        hunks: result.hunksApplied ?? 0,
        ...(result.linesAdded !== undefined
          ? { linesAdded: result.linesAdded }
          : {}),
        ...(result.linesRemoved !== undefined
          ? { linesRemoved: result.linesRemoved }
          : {}),
      },
    ],
    summary: { total: 1, succeeded: 1, failed: 0 },
  });
}

async function handleApplyPatch(
  args: z.infer<typeof ApplyPatchInputSchema>,
  signal?: AbortSignal
): Promise<ToolResult<z.infer<typeof ApplyPatchOutputSchema>>> {
  const parsed = parseAndValidatePatch(args.patch);

  const options: PatchOptions = {
    dryRun: args.dryRun,
    fuzzFactor: args.fuzzFactor,
    autoConvertLineEndings: args.autoConvertLineEndings,
  };

  const targetPath = args.path ?? '';

  if (parsed.length > 1) {
    return processMultiFilePatch(targetPath, parsed, options, signal);
  }

  const diff = parsed[0];
  if (!diff) {
    throw new McpError(ErrorCode.INVALID_INPUT, 'No patch content found.');
  }

  return handleSingleFilePatch(targetPath, diff, options, signal);
}

type PatchInput = z.infer<typeof ApplyPatchInputSchema>;
type PatchOutput = z.infer<typeof ApplyPatchOutputSchema>;

export const APPLY_PATCH = defineTool<PatchInput, PatchOutput>({
  contract: APPLY_PATCH_TOOL,
  defaultErrorCode: ErrorCode.UNKNOWN,
  run: async (args, ctx) => {
    const result = await handleApplyPatch(args, ctx.signal);
    if (!result.isError && !args.dryRun) {
      const sc = result.structuredContent;
      const added = sc.files.reduce((s, f) => s + (f.linesAdded ?? 0), 0);
      const removed = sc.files.reduce((s, f) => s + (f.linesRemoved ?? 0), 0);
      void ctx.log?.(
        'info',
        `patch: ${args.path ?? ''} (+${String(added)}/-${String(removed)})`,
        'apply_patch'
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
  completionMessage: (
    args: PatchInput,
    result: ToolResult<PatchOutput>
  ): string => {
    const name = basename(args.path ?? '');
    if (result.isError)
      return `${APPLY_PATCH_TOOL.title}: ${name} • ${result.errorCode}`;
    const sc = result.structuredContent;
    const added = sc.files.reduce((s, f) => s + (f.linesAdded ?? 0), 0);
    const removed = sc.files.reduce((s, f) => s + (f.linesRemoved ?? 0), 0);
    const dry = args.dryRun ? 'dry run ' : '';
    if (added > 0 || removed > 0)
      return `${APPLY_PATCH_TOOL.title}: ${name} • ${dry}+${added} -${removed}`;
    return `${APPLY_PATCH_TOOL.title}: ${name} • ${dry}no changes`;
  },
});
