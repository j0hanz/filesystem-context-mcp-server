import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTwoFilesPatch } from 'diff';
import type { z } from 'zod';

import { MAX_TEXT_FILE_SIZE } from '../lib/constants.js';
import { ErrorCode, McpError } from '../lib/errors.js';
import { withAbort } from '../lib/fs-helpers.js';
import { validateExistingPath } from '../lib/paths.js';

import { DiffFilesInputSchema, DiffFilesOutputSchema } from '../schemas.js';
import {
  buildResourceLink,
  buildToolErrorResponse,
  buildToolResponse,
  executeToolWithDiagnostics,
  maybeExternalizeTextContent,
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

export const DIFF_FILES_TOOL: ToolContract = {
  name: 'diff_files',
  title: 'Diff Files',
  description:
    'Generate a unified diff between two files. ' +
    'Output feeds directly into `apply_patch`. ' +
    '`isIdentical=true` means files match \u2014 no patch needed.',
  inputSchema: DiffFilesInputSchema,
  outputSchema: DiffFilesOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  gotchas: ['`isIdentical=true` means no hunks (`@@`) and empty diff.'],
} as const;

function assertDiffFileSizeWithinLimit(
  filePath: string,
  size: number,
  maxFileSize: number
): void {
  if (size <= maxFileSize) return;
  throw new McpError(
    ErrorCode.E_TOO_LARGE,
    `File too large for diff: ${filePath} (${size} bytes > ${maxFileSize} bytes).`,
    filePath,
    { size, maxFileSize }
  );
}

async function handleDiffFiles(
  args: z.infer<typeof DiffFilesInputSchema>,
  signal?: AbortSignal,
  resourceStore?: ToolRegistrationOptions['resourceStore']
): Promise<ToolResponse<z.infer<typeof DiffFilesOutputSchema>>> {
  const maxFileSize = MAX_TEXT_FILE_SIZE;
  const [originalPath, modifiedPath] = await Promise.all([
    validateExistingPath(args.original, signal),
    validateExistingPath(args.modified, signal),
  ]);

  const [originalStats, modifiedStats] = await Promise.all([
    withAbort(fs.stat(originalPath), signal),
    withAbort(fs.stat(modifiedPath), signal),
  ]);

  assertDiffFileSizeWithinLimit(originalPath, originalStats.size, maxFileSize);
  assertDiffFileSizeWithinLimit(modifiedPath, modifiedStats.size, maxFileSize);

  const [originalContent, modifiedContent] = await Promise.all([
    fs.readFile(originalPath, { encoding: 'utf-8', signal }),
    fs.readFile(modifiedPath, { encoding: 'utf-8', signal }),
  ]);

  const patch = createTwoFilesPatch(
    path.basename(originalPath),
    path.basename(modifiedPath),
    originalContent,
    modifiedContent,
    undefined,
    undefined,
    {
      ...(args.context !== undefined ? { context: args.context } : {}),
      ignoreWhitespace: args.ignoreWhitespace,
      stripTrailingCr: args.stripTrailingCr,
    }
  );

  const isIdentical = !patch.includes('@@');
  const diffText = isIdentical ? '' : patch;

  const externalized = maybeExternalizeTextContent(resourceStore, diffText, {
    name: 'diff:patch',
    mimeType: 'text/x-diff',
  });

  if (!externalized) {
    return buildToolResponse(isIdentical ? 'No differences' : diffText, {
      ok: true,
      diff: diffText,
      isIdentical,
    });
  }

  const { preview, entry } = externalized;
  return buildToolResponse(
    preview,
    {
      ok: true,
      diff: preview,
      isIdentical,
      truncated: true,
      resourceUri: entry.uri,
    },
    [
      buildResourceLink({
        uri: entry.uri,
        name: entry.name,
        mimeType: entry.mimeType,
        description: 'Full diff content',
      }),
    ]
  );
}

export function registerDiffFilesTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof DiffFilesInputSchema>,
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof DiffFilesOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'diff_files',
      extra,
      timedSignal: {},
      context: { path: args.original },
      run: (signal) => handleDiffFiles(args, signal, options.resourceStore),
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.E_UNKNOWN, args.original),
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    progressMessage: (args) => {
      const n1 = path.basename(args.original);
      const n2 = path.basename(args.modified);
      return `🕮 diff: ${n1} ⟷ ${n2}`;
    },
    completionMessage: (args, result) => {
      const n1 = path.basename(args.original);
      const n2 = path.basename(args.modified);
      if (result.isError) return `🕮 diff: ${n1} ⟷ ${n2} • failed`;
      const sc = result.structuredContent;
      if (!sc.ok) return `🕮 diff: ${n1} ⟷ ${n2} • failed`;
      if (sc.isIdentical) return `🕮 diff: ${n1} ⟷ ${n2} • identical`;
      return `🕮 diff: ${n1} ⟷ ${n2} • changed`;
    },
  });

  const validatedHandler = withValidatedArgs(
    DiffFilesInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      'diff_files',
      DIFF_FILES_TOOL,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  )
    return;
  server.registerTool(
    'diff_files',
    withDefaultIcons({ ...DIFF_FILES_TOOL }, options.iconInfo),
    validatedHandler
  );
}
