import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode } from '../lib/errors.js';
import { atomicWriteFile } from '../lib/fs-helpers.js';
import { validateExistingPath } from '../lib/path-validation.js';
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
    'Edit a file by replacing text. Sequentially applies a list of string replacements. ' +
    'Replaces the first occurrence of each `oldText`. ' +
    '`oldText` must match exactly — include 3–5 lines of surrounding context to uniquely target the location. ' +
    'Use `dryRun: true` to validate edits before writing.',
  inputSchema: EditFileInputSchema,
  outputSchema: EditFileOutputSchema,
  annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  nuances: [
    'Apply sequential literal replacements (first occurrence per edit).',
  ],
  gotchas: [
    '`oldText` must match exactly; unmatched items are reported in `unmatchedEdits`.',
  ],
} as const;

interface EditResult {
  content: string;
  appliedEdits: number;
  unmatchedEdits: string[];
  lineRange?: [number, number];
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
      const regex = new RegExp(pattern);
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

  const result: EditResult = {
    content: newContent,
    appliedEdits,
    unmatchedEdits,
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
  const content = await fs.readFile(validPath, { encoding: 'utf-8', signal });

  const {
    content: newContent,
    appliedEdits,
    unmatchedEdits,
    lineRange,
  } = applyEdits(content, args.edits, args.ignoreWhitespace);

  const structured: z.infer<typeof EditFileOutputSchema> = {
    ok: true,
    path: validPath,
    appliedEdits,
    ...(unmatchedEdits.length > 0 ? { unmatchedEdits } : {}),
    ...(lineRange ? { lineRange } : {}),
  };

  if (args.dryRun) {
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
      const dryTag = args.dryRun ? ' [dry run]' : '';
      return `🛠 edit: ${name} [${args.edits.length} edits]${dryTag}`;
    },
    completionMessage: (args, result) => {
      const name = path.basename(args.path);
      if (result.isError) return `🛠 edit: ${name} • failed`;
      const sc = result.structuredContent;
      if (!sc.ok) return `🛠 edit: ${name} • failed`;

      const applied = sc.appliedEdits ?? 0;
      const unmatched = sc.unmatchedEdits?.length ?? 0;
      const dryPrefix = args.dryRun ? 'dry run — ' : '';
      if (unmatched > 0) {
        return `🛠 edit: ${name} • ${dryPrefix}${applied} applied, ${unmatched} unmatched`;
      }
      if (sc.lineRange) {
        return `🛠 edit: ${name} • ${dryPrefix}lines ${sc.lineRange[0]}–${sc.lineRange[1]}`;
      }
      return `🛠 edit: ${name} • ${dryPrefix}${applied} applied`;
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
