import * as path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { applyPatch, parsePatch, type StructuredPatch } from 'diff';
import type { z } from 'zod';

import { MAX_TEXT_FILE_SIZE, PARALLEL_CONCURRENCY } from '../lib/constants.js';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  McpError,
} from '../lib/errors.js';
import {
  atomicWriteFile,
  processInParallel,
  withAbort,
} from '../lib/fs-helpers.js';
import { assertAllowedFileAccess, validateExistingPath } from '../lib/paths.js';

import { ApplyPatchInputSchema, ApplyPatchOutputSchema } from '../schemas.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  executeToolWithDiagnostics,
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

export const APPLY_PATCH_TOOL: ToolContract = {
  name: 'apply_patch',
  title: 'Apply Patch',
  description:
    'Apply a unified diff patch to one or more files. ' +
    'Single-file: throws on failure. Multi-file: best-effort per file with `results[]`. ' +
    'Workflow: `diff_files` \u2192 `apply_patch(dryRun:true)` \u2192 `apply_patch`. ' +
    'On failure, regenerate the patch from current file content.',
  inputSchema: ApplyPatchInputSchema,
  outputSchema: ApplyPatchOutputSchema,
  annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  nuances: [
    'Multi-file patches use `path` as base directory; per-file results in `results[]`.',
  ],
  taskSupport: 'forbidden',
} as const;

function assertPatchTargetSizeWithinLimit(
  filePath: string,
  size: number,
  maxFileSize: number
): void {
  if (size <= maxFileSize) return;
  throw new McpError(
    ErrorCode.E_TOO_LARGE,
    `File too large for patch: ${filePath} (${size} bytes > ${maxFileSize} bytes).`,
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

type PatchFileResult = NonNullable<
  z.infer<typeof ApplyPatchOutputSchema>['results']
>[number];

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

  const stats = await withAbort(stat(validPath), signal);
  assertPatchTargetSizeWithinLimit(validPath, stats.size, MAX_TEXT_FILE_SIZE);

  const content = await readFile(validPath, { encoding: 'utf-8', signal });

  const patched = applyPatch(content, diff, {
    fuzzFactor: options.fuzzFactor,
    autoConvertLineEndings: options.autoConvertLineEndings,
  });

  if (patched === false) {
    return {
      path: validPath,
      applied: false,
      error: 'Patch application failed',
    };
  }
  if (patched === content) {
    return { path: validPath, applied: false, error: 'Patch had no effect' };
  }

  const patchStats = countStructuredPatchStats(diff);

  if (!options.dryRun) {
    await atomicWriteFile(validPath, patched, { encoding: 'utf-8', signal });
  }

  return { path: validPath, applied: true, ...patchStats };
}

async function processMultiFilePatch(
  basePath: string,
  parsed: StructuredPatch[],
  options: PatchOptions,
  signal?: AbortSignal
): Promise<ToolResponse<z.infer<typeof ApplyPatchOutputSchema>>> {
  const validBase = await validateExistingPath(basePath, signal);

  const promises = parsed.map((diff) => {
    const fileName = extractPatchTargetPath(diff);
    if (!fileName) {
      return (): Promise<PatchFileResult> =>
        Promise.resolve({
          path: '<unknown>',
          applied: false,
          error: 'Missing file name in patch header',
        });
    }

    const filePath = path.resolve(validBase, fileName);
    return async (): Promise<PatchFileResult> => {
      try {
        const result = await applyDiff(filePath, diff, options, signal);
        return { ...result, path: fileName };
      } catch (error) {
        return {
          path: fileName,
          applied: false,
          error: formatUnknownErrorMessage(error),
        };
      }
    };
  });

  const { results } = await processInParallel(
    promises,
    (task) => task(),
    PARALLEL_CONCURRENCY,
    signal
  );

  const totals = results.reduce(
    (acc, r) => {
      if (r.applied) {
        acc.applied++;
        acc.hunks += r.hunksApplied ?? 0;
        acc.added += r.linesAdded ?? 0;
        acc.removed += r.linesRemoved ?? 0;
      }
      return acc;
    },
    { applied: 0, hunks: 0, added: 0, removed: 0 }
  );

  const label = options.dryRun ? ' (dry run)' : '';
  const text = `Applied ${totals.applied}/${parsed.length} file patches${label}`;

  return buildToolResponse(text, {
    ok: totals.applied === parsed.length,
    path: basePath,
    applied: totals.applied > 0,
    hunksApplied: totals.hunks,
    linesAdded: totals.added,
    linesRemoved: totals.removed,
    results,
  });
}

async function handleApplyPatch(
  args: z.infer<typeof ApplyPatchInputSchema>,
  signal?: AbortSignal
): Promise<ToolResponse<z.infer<typeof ApplyPatchOutputSchema>>> {
  if (!args.patch.trim()) {
    throw new McpError(ErrorCode.E_INVALID_INPUT, 'Patch content is empty.');
  }

  const fuzzFactor = args.fuzzFactor ?? 0;
  const parsed = parsePatch(args.patch);

  const hasHunks = parsed.some((p) => p.hunks.length > 0);
  if (!hasHunks) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Patch must include unified hunk headers (e.g., @@ -1,2 +1,2 @@).'
    );
  }

  const options: PatchOptions = {
    dryRun: args.dryRun,
    fuzzFactor,
    autoConvertLineEndings: args.autoConvertLineEndings,
  };
  if (parsed.length > 1) {
    return processMultiFilePatch(args.path, parsed, options, signal);
  }
  const diff = parsed[0];
  if (!diff) {
    throw new McpError(ErrorCode.E_INVALID_INPUT, 'No patch content found.');
  }

  const result = await applyDiff(args.path, diff, options, signal);

  if (!result.applied) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      result.error === 'Patch had no effect'
        ? 'Patch had no effect \u2014 the file content is unchanged after applying. The patch may not match the current file content. Generate a fresh patch via diff_files and retry.'
        : 'Patch application failed. The file content may have changed or patch context is insufficient. Generate a fresh patch via diff_files against the current file, then retry. If differences are minor, enable fuzzy matching with the fuzzFactor parameter.'
    );
  }

  const text = args.dryRun
    ? 'Dry run successful. Patch can be applied.'
    : `Successfully patched ${args.path}`;

  return buildToolResponse(text, {
    ok: true,
    path: result.path,
    applied: true,
    hunksApplied: result.hunksApplied,
    linesAdded: result.linesAdded,
    linesRemoved: result.linesRemoved,
  });
}

export function registerApplyPatchTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof ApplyPatchInputSchema>,
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof ApplyPatchOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'apply_patch',
      extra,
      outputSchema: ApplyPatchOutputSchema,
      timedSignal: {},
      context: { path: args.path },
      run: (signal) => handleApplyPatch(args, signal),
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.E_UNKNOWN, args.path),
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    progressMessage: (args) => {
      const name = path.basename(args.path);
      return args.dryRun ? `🛠 patch: ${name} [dry run]` : `🛠 patch: ${name}`;
    },
    completionMessage: (args, result) => {
      const name = path.basename(args.path);
      if (result.isError) return `🛠 patch: ${name} • failed`;
      const sc = result.structuredContent;
      if (!sc.ok) return `🛠 patch: ${name} • failed`;
      const added = sc.linesAdded ?? 0;
      const removed = sc.linesRemoved ?? 0;
      const dry = args.dryRun ? 'dry run ' : '';
      if (added > 0 || removed > 0)
        return `🛠 patch: ${name} • ${dry} +${added} -${removed}`;
      return `🛠 patch: ${name} • ${dry}no changes`;
    },
  });

  const validatedHandler = withValidatedArgs(
    ApplyPatchInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      'apply_patch',
      APPLY_PATCH_TOOL,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  )
    return;
  server.registerTool(
    'apply_patch',
    withDefaultIcons({ ...APPLY_PATCH_TOOL }, options.iconInfo),
    validatedHandler
  );
}
