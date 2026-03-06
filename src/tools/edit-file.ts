import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTwoFilesPatch } from 'diff';
import RE2 from 're2';
import type { z } from 'zod';

import { MAX_TEXT_FILE_SIZE } from '../lib/constants.js';
import { ErrorCode, McpError } from '../lib/errors.js';
import { atomicWriteFile, withAbort } from '../lib/fs-helpers.js';
import { assertAllowedFileAccess, validateExistingPath } from '../lib/paths.js';

import { EditFileInputSchema, EditFileOutputSchema } from '../schemas.js';
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

export const EDIT_FILE_TOOL: ToolContract = {
  name: 'edit',
  title: 'Edit File',
  description:
    'Apply sequential literal string replacements to a file (first occurrence per edit). ' +
    '`oldText` must match exactly \u2014 include 3\u20135 lines of context for unique targeting. ' +
    'Use `dryRun:true` to preview.',
  inputSchema: EditFileInputSchema,
  outputSchema: EditFileOutputSchema,
  annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  nuances: ['Each edit applies to the output of the previous edit.'],
  gotchas: ['Unmatched `oldText` entries listed in `unmatchedEdits`.'],
  taskSupport: 'forbidden',
} as const;

interface EditResult {
  content: string;
  appliedEdits: number;
  unmatchedEdits: string[];
  linesAdded: number;
  linesRemoved: number;
  lineRange?: [number, number];
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function computeDiffStats(
  original: string,
  modified: string
): { linesAdded: number; linesRemoved: number } {
  const patch = createTwoFilesPatch('a', 'b', original, modified);
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
    else if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
  }
  return { linesAdded, linesRemoved };
}

function applyEdits(
  content: string,
  edits: z.infer<typeof EditFileInputSchema>['edits'],
  ignoreWhitespace: boolean
): EditResult {
  let newContent = content;
  let appliedEdits = 0;
  const unmatchedEdits: string[] = [];
  let minLine: number | undefined;
  let maxLine: number | undefined;

  for (const edit of edits) {
    if (ignoreWhitespace) {
      const pattern = escapeRegExp(edit.oldText).replace(/\s+/g, '\\s+');
      const regex = new RE2(pattern);
      const match = regex.exec(newContent);

      if (!match) {
        unmatchedEdits.push(edit.oldText);
        continue;
      }

      const { index } = match;
      const matchLength = match[0].length;
      const linesBefore = newContent.slice(0, index).split('\n').length;
      const newTextLines = edit.newText.split('\n').length;
      const startLine = linesBefore;
      const endLine = linesBefore + newTextLines - 1;

      if (minLine === undefined || startLine < minLine) minLine = startLine;
      if (maxLine === undefined || endLine > maxLine) maxLine = endLine;

      newContent =
        newContent.slice(0, index) +
        edit.newText +
        newContent.slice(index + matchLength);
      appliedEdits += 1;
    } else {
      if (!newContent.includes(edit.oldText)) {
        unmatchedEdits.push(edit.oldText);
        continue;
      }

      const index = newContent.indexOf(edit.oldText);
      const linesBefore = newContent.slice(0, index).split('\n').length;
      const newTextLines = edit.newText.split('\n').length;
      const startLine = linesBefore;
      const endLine = linesBefore + newTextLines - 1;

      if (minLine === undefined || startLine < minLine) minLine = startLine;
      if (maxLine === undefined || endLine > maxLine) maxLine = endLine;

      newContent = newContent.replace(edit.oldText, () => edit.newText);
      appliedEdits += 1;
    }
  }

  const { linesAdded, linesRemoved } =
    appliedEdits > 0
      ? computeDiffStats(content, newContent)
      : { linesAdded: 0, linesRemoved: 0 };

  const result: EditResult = {
    content: newContent,
    appliedEdits,
    unmatchedEdits,
    linesAdded,
    linesRemoved,
  };

  if (minLine !== undefined && maxLine !== undefined) {
    result.lineRange = [minLine, maxLine];
  }

  return result;
}

export async function handleEditFile(
  args: z.infer<typeof EditFileInputSchema>,
  signal?: AbortSignal
): Promise<ToolResponse<z.infer<typeof EditFileOutputSchema>>> {
  const validPath = await validateExistingPath(args.path, signal);
  assertAllowedFileAccess(args.path, validPath);
  const stats = await withAbort(fs.stat(validPath), signal);
  if (stats.size > MAX_TEXT_FILE_SIZE) {
    throw new McpError(
      ErrorCode.E_TOO_LARGE,
      `File too large for edit: ${args.path} (${stats.size} bytes > ${MAX_TEXT_FILE_SIZE} bytes)`,
      args.path,
      { size: stats.size, maxFileSize: MAX_TEXT_FILE_SIZE }
    );
  }
  const content = await fs.readFile(validPath, { encoding: 'utf-8', signal });

  const {
    content: newContent,
    appliedEdits,
    unmatchedEdits,
    linesAdded,
    linesRemoved,
    lineRange,
  } = applyEdits(content, args.edits, args.ignoreWhitespace);

  const structured: z.infer<typeof EditFileOutputSchema> = {
    ok: true,
    path: validPath,
    appliedEdits,
    ...(appliedEdits > 0 ? { linesAdded, linesRemoved } : {}),
    ...(unmatchedEdits.length > 0 ? { unmatchedEdits } : {}),
    ...(lineRange ? { lineRange } : {}),
  };

  if (args.dryRun) {
    if (appliedEdits > 0) {
      structured.diff = createTwoFilesPatch(
        path.basename(validPath),
        path.basename(validPath),
        content,
        newContent,
        'Original',
        'Modified'
      );
    }
    return buildToolResponse(
      `Dry run complete. ${appliedEdits} edits would be applied.`,
      structured
    );
  }

  if (appliedEdits > 0) {
    await atomicWriteFile(validPath, newContent, { encoding: 'utf-8', signal });
  }

  const unmatchedNote =
    unmatchedEdits.length > 0
      ? ` — ${unmatchedEdits.length} unmatched: [${unmatchedEdits
          .map((s) =>
            JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}\u2026` : s)
          )
          .join(', ')}]`
      : '';
  const message =
    appliedEdits === 0
      ? `No edits applied to ${args.path}${unmatchedNote}`
      : `Successfully applied ${appliedEdits} edits to ${args.path}${unmatchedNote}`;

  return buildToolResponse(message, structured);
}

export function registerEditFileTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof EditFileInputSchema>,
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof EditFileOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'edit',
      extra,
      timedSignal: {},
      context: { path: args.path },
      run: (signal) => handleEditFile(args, signal),
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.E_UNKNOWN, args.path),
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    progressMessage: (args) => {
      const name = path.basename(args.path);
      const tag = args.dryRun ? ' [dry run]' : '';
      return `🛠 edit: ${name}${tag}`;
    },
    completionMessage: (args, result) => {
      const name = path.basename(args.path);
      if (result.isError) return `🛠 edit: ${name} • failed`;
      const sc = result.structuredContent;
      if (!sc.ok) return `🛠 edit: ${name} • failed`;

      const applied = sc.appliedEdits ?? 0;
      if (applied === 0) return `🛠 edit: ${name} • no changes`;
      const added = sc.linesAdded ?? 0;
      const removed = sc.linesRemoved ?? 0;
      const dry = args.dryRun ? 'dry run ' : '';
      return `🛠 edit: ${name} • ${dry} +${added} -${removed}`;
    },
  });

  const validatedHandler = withValidatedArgs(
    EditFileInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      'edit',
      EDIT_FILE_TOOL,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  )
    return;
  server.registerTool(
    'edit',
    withDefaultIcons({ ...EDIT_FILE_TOOL }, options.iconInfo),
    validatedHandler
  );
}
