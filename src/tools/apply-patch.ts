import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { applyPatch } from 'diff';
import type { z } from 'zod';

import { MAX_TEXT_FILE_SIZE } from '../lib/constants.js';
import { ErrorCode, McpError } from '../lib/errors.js';
import { atomicWriteFile, withAbort } from '../lib/fs-helpers.js';
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
    'Apply a unified diff patch to a file. ' +
    'Workflow: `diff_files` \u2192 `apply_patch(dryRun:true)` \u2192 `apply_patch`. ' +
    'On failure, regenerate the patch from current file content.',
  inputSchema: ApplyPatchInputSchema,
  outputSchema: ApplyPatchOutputSchema,
  annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  gotchas: ['Patch must include valid hunk headers; use `dryRun=true` first.'],
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

function assertPatchHasHunks(patch: string): void {
  if (!patch.trim()) {
    throw new McpError(ErrorCode.E_INVALID_INPUT, 'Patch content is empty.');
  }
  const hasHunk = /@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(patch);
  if (!hasHunk) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Patch must include unified hunk headers (e.g., @@ -1,2 +1,2 @@).'
    );
  }
}

async function handleApplyPatch(
  args: z.infer<typeof ApplyPatchInputSchema>,
  signal?: AbortSignal
): Promise<ToolResponse<z.infer<typeof ApplyPatchOutputSchema>>> {
  const maxFileSize = MAX_TEXT_FILE_SIZE;
  const validPath = await validateExistingPath(args.path, signal);
  assertAllowedFileAccess(args.path, validPath);
  const stats = await withAbort(fs.stat(validPath), signal);
  assertPatchTargetSizeWithinLimit(validPath, stats.size, maxFileSize);
  const content = await fs.readFile(validPath, { encoding: 'utf-8', signal });

  const fuzzFactor = args.fuzzFactor ?? 0;

  assertPatchHasHunks(args.patch);

  const patched = applyPatch(content, args.patch, {
    fuzzFactor,
    autoConvertLineEndings: args.autoConvertLineEndings,
  });

  if (patched === false) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Patch application failed. The file content may have changed or patch context is insufficient. Generate a fresh patch via diff_files against the current file, then retry. If differences are minor, enable fuzzy matching with the fuzzFactor parameter.'
    );
  }

  if (patched === content) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Patch had no effect — the file content is unchanged after applying. The patch may not match the current file content. Generate a fresh patch via diff_files and retry.'
    );
  }

  if (args.dryRun) {
    return buildToolResponse('Dry run successful. Patch can be applied.', {
      ok: true,
      path: validPath,
      applied: true,
    });
  }

  await atomicWriteFile(validPath, patched, { encoding: 'utf-8', signal });

  return buildToolResponse(`Successfully patched ${args.path}`, {
    ok: true,
    path: validPath,
    applied: true,
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
      return args.dryRun
        ? `🛠 apply_patch: ${name} [dry run]`
        : `🛠 apply_patch: ${name}`;
    },
    completionMessage: (args, result) => {
      const name = path.basename(args.path);
      if (result.isError) return `🛠 apply_patch: ${name} • failed`;
      const sc = result.structuredContent;
      if (!sc.ok) return `🛠 apply_patch: ${name} • failed`;
      if (args.dryRun) return `🛠 apply_patch: ${name} • dry run OK`;
      return `🛠 apply_patch: ${name} • applied`;
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
