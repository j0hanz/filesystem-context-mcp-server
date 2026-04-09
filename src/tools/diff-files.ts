import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { formatPatch, structuredPatch, type StructuredPatch } from 'diff';
import type { z } from 'zod';

import { withAbort } from '../lib/abort.js';
import { MAX_TEXT_FILE_SIZE } from '../lib/constants.js';
import { ErrorCode, McpError } from '../lib/errors.js';
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
  taskSupport: 'forbidden',
} as const;

function computeDiffStats(hunks: StructuredPatch['hunks']): {
  linesAdded: number;
  linesRemoved: number;
  hunksCount: number;
} {
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
      else if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
    }
  }

  return { linesAdded, linesRemoved, hunksCount: hunks.length };
}

function assertDiffFileSizeWithinLimit(
  filePath: string,
  size: number,
  maxFileSize: number
): void {
  if (size <= maxFileSize) return;
  throw new McpError(
    ErrorCode.TOO_LARGE,
    `File too large for diff (${size} bytes > ${maxFileSize} bytes).`,
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
    withAbort(stat(originalPath), signal),
    withAbort(stat(modifiedPath), signal),
  ]);

  assertDiffFileSizeWithinLimit(originalPath, originalStats.size, maxFileSize);
  assertDiffFileSizeWithinLimit(modifiedPath, modifiedStats.size, maxFileSize);

  const [originalContent, modifiedContent] = await Promise.all([
    readFile(originalPath, { encoding: 'utf-8', signal }),
    readFile(modifiedPath, { encoding: 'utf-8', signal }),
  ]);

  const patchObj = await new Promise<StructuredPatch | undefined>((resolve) => {
    structuredPatch(
      basename(originalPath),
      basename(modifiedPath),
      originalContent,
      modifiedContent,
      undefined,
      undefined,
      {
        ...(args.context !== undefined ? { context: args.context } : {}),
        ignoreWhitespace: args.ignoreWhitespace,
        stripTrailingCr: args.stripTrailingCr,
        timeout: 10000,
        callback: (res) => {
          resolve(res);
        },
      }
    );
  });

  if (!patchObj) {
    throw new McpError(
      ErrorCode.TIMEOUT,
      `Diff timed out or too complex.`,
      originalPath
    );
  }

  const isIdentical = patchObj.hunks.length === 0;
  const diffText = isIdentical ? '' : formatPatch(patchObj);
  const stats = isIdentical ? undefined : computeDiffStats(patchObj.hunks);

  const externalized = maybeExternalizeTextContent(resourceStore, diffText, {
    name: 'diff:patch',
    mimeType: 'text/x-diff',
  });

  if (!externalized) {
    return buildToolResponse(isIdentical ? 'No differences' : diffText, {
      ok: true,
      diff: diffText,
      isIdentical,
      ...(stats ?? {}),
    });
  }

  const { preview, entry } = externalized;
  return buildToolResponse(
    preview,
    {
      ok: true,
      diff: preview,
      isIdentical,
      ...(stats ?? {}),
      truncated: true,
      resourceUri: entry.uri,
    },
    [
      buildResourceLink({
        uri: entry.uri,
        name: entry.name,
        mimeType: entry.mimeType,
        description: 'Full diff content',
        expiresAt: entry.expiresAt,
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
      outputSchema: DiffFilesOutputSchema,
      timedSignal: {},
      context: { path: args.original },
      run: (signal) => handleDiffFiles(args, signal, options.resourceStore),
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.UNKNOWN, args.original),
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    progressMessage: (args) => {
      const n1 = basename(args.original);
      const n2 = basename(args.modified);
      return `🕮 diff: ${n1} ⟷ ${n2}`;
    },
    completionMessage: (args, result) => {
      const n1 = basename(args.original);
      const n2 = basename(args.modified);
      if (result.isError) return `🕮 diff: ${n1} ⟷ ${n2} • failed`;
      const sc = result.structuredContent;
      if (sc.isIdentical) return `🕮 diff: ${n1} ⟷ ${n2} • identical`;
      const added = sc.linesAdded ?? 0;
      const removed = sc.linesRemoved ?? 0;
      if (added > 0 || removed > 0)
        return `🕮 diff: ${n1} ⟷ ${n2} • +${added} -${removed}`;
      return `🕮 diff: ${n1} ⟷ ${n2}`;
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
