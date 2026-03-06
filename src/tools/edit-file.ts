import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTwoFilesPatch, diffLines } from 'diff';
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
    '`oldText` must match exactly — include 3–5 lines of context for unique targeting. ' +
    'Use `dryRun:true` to preview.',
  inputSchema: EditFileInputSchema,
  outputSchema: EditFileOutputSchema,
  annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  nuances: ['Each edit applies to the output of the previous edit.'],
  gotchas: ['Unmatched `oldText` entries listed in `unmatchedEdits`.'],
  taskSupport: 'forbidden',
} as const;

type EditInput = z.infer<typeof EditFileInputSchema>;
type EditOutput = z.infer<typeof EditFileOutputSchema>;

interface TextRange {
  startIndex: number;
  length: number;
}

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

function getLineNumberAtIndex(
  str: string,
  maxIndex: number = str.length
): number {
  let count = 1;
  let pos = 0;
  while (pos < maxIndex) {
    pos = str.indexOf('\n', pos);
    if (pos === -1 || pos >= maxIndex) break;
    count++;
    pos++;
  }
  return count;
}

function countLines(str: string): number {
  return getLineNumberAtIndex(str);
}

function computeDiffStats(
  original: string,
  modified: string
): { linesAdded: number; linesRemoved: number } {
  const changes = diffLines(original, modified);
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const part of changes) {
    if (part.added) {
      linesAdded += part.count;
    } else if (part.removed) {
      linesRemoved += part.count;
    }
  }

  return { linesAdded, linesRemoved };
}

function findEditMatch(
  content: string,
  oldText: string,
  ignoreWhitespace: boolean
): TextRange | undefined {
  if (ignoreWhitespace) {
    const pattern = escapeRegExp(oldText).replace(/\s+/g, '\\s+');
    const regex = new RE2(pattern);
    const match = regex.exec(content);

    if (!match) {
      return undefined;
    }

    return {
      startIndex: match.index,
      length: match[0].length,
    };
  }

  const index = content.indexOf(oldText);
  if (index === -1) {
    return undefined;
  }

  return {
    startIndex: index,
    length: oldText.length,
  };
}

function replaceEditMatch(
  content: string,
  match: TextRange,
  newText: string
): string {
  return (
    content.slice(0, match.startIndex) +
    newText +
    content.slice(match.startIndex + match.length)
  );
}

function mergeLineRange(
  currentRange: EditResult['lineRange'],
  content: string,
  matchStartIndex: number,
  newText: string
): [number, number] {
  const startLine = getLineNumberAtIndex(content, matchStartIndex);
  const endLine = startLine + countLines(newText) - 1;

  if (!currentRange) {
    return [startLine, endLine];
  }

  return [
    Math.min(currentRange[0], startLine),
    Math.max(currentRange[1], endLine),
  ];
}

function buildStructuredEditOutput(
  validPath: string,
  result: EditResult
): EditOutput {
  return {
    ok: true,
    path: validPath,
    appliedEdits: result.appliedEdits,
    ...(result.appliedEdits > 0
      ? {
          linesAdded: result.linesAdded,
          linesRemoved: result.linesRemoved,
        }
      : {}),
    ...(result.unmatchedEdits.length > 0
      ? { unmatchedEdits: result.unmatchedEdits }
      : {}),
    ...(result.lineRange ? { lineRange: result.lineRange } : {}),
  };
}

function finalizeEditResult(
  originalContent: string,
  updatedContent: string,
  appliedEdits: number,
  unmatchedEdits: string[],
  lineRange: EditResult['lineRange']
): EditResult {
  const { linesAdded, linesRemoved } =
    appliedEdits > 0
      ? computeDiffStats(originalContent, updatedContent)
      : { linesAdded: 0, linesRemoved: 0 };

  return {
    content: updatedContent,
    appliedEdits,
    unmatchedEdits,
    linesAdded,
    linesRemoved,
    ...(lineRange ? { lineRange } : {}),
  };
}

function buildDiff(
  validPath: string,
  original: string,
  modified: string
): string {
  const fileName = basename(validPath);
  return createTwoFilesPatch(
    fileName,
    fileName,
    original,
    modified,
    'Original',
    'Modified'
  );
}

function formatUnmatchedEditsNote(unmatchedEdits: string[]): string {
  if (unmatchedEdits.length === 0) {
    return '';
  }

  return ` — ${unmatchedEdits.length} unmatched: [${unmatchedEdits
    .map((text) =>
      JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text)
    )
    .join(', ')}]`;
}

function buildEditMessage(requestedPath: string, result: EditResult): string {
  const unmatchedNote = formatUnmatchedEditsNote(result.unmatchedEdits);

  if (result.appliedEdits === 0) {
    return `No edits applied to ${requestedPath}${unmatchedNote}`;
  }

  return `Successfully applied ${result.appliedEdits} edits to ${requestedPath}${unmatchedNote}`;
}

async function loadEditableFile(
  requestedPath: string,
  signal?: AbortSignal
): Promise<{ validPath: string; content: string }> {
  const validPath = await validateExistingPath(requestedPath, signal);
  assertAllowedFileAccess(requestedPath, validPath);
  const stats = await withAbort(stat(validPath), signal);

  if (stats.size > MAX_TEXT_FILE_SIZE) {
    throw new McpError(
      ErrorCode.E_TOO_LARGE,
      `File too large for edit: ${requestedPath} (${stats.size} bytes > ${MAX_TEXT_FILE_SIZE} bytes)`,
      requestedPath,
      { size: stats.size, maxFileSize: MAX_TEXT_FILE_SIZE }
    );
  }

  const content = await readFile(validPath, { encoding: 'utf-8', signal });
  return { validPath, content };
}

function buildEditProgressMessage(args: EditInput): string {
  const name = basename(args.path);
  const tag = args.dryRun ? ' [dry run]' : '';
  return `🛠 edit: ${name}${tag}`;
}

function buildEditCompletionMessage(
  args: EditInput,
  result: ToolResult<EditOutput>
): string {
  const name = basename(args.path);
  if (result.isError) return `🛠 edit: ${name} • failed`;

  const { structuredContent } = result;
  if (!structuredContent.ok) return `🛠 edit: ${name} • failed`;

  const applied = structuredContent.appliedEdits ?? 0;
  if (applied === 0) return `🛠 edit: ${name} • no changes`;

  const added = structuredContent.linesAdded ?? 0;
  const removed = structuredContent.linesRemoved ?? 0;
  const dry = args.dryRun ? 'dry run ' : '';
  return `🛠 edit: ${name} • ${dry}+${added} -${removed}`;
}

function applyEdits(
  content: string,
  edits: EditInput['edits'],
  ignoreWhitespace: boolean
): EditResult {
  let newContent = content;
  let appliedEdits = 0;
  const unmatchedEdits: string[] = [];
  let lineRange: EditResult['lineRange'];

  for (const edit of edits) {
    const match = findEditMatch(newContent, edit.oldText, ignoreWhitespace);

    if (!match) {
      unmatchedEdits.push(edit.oldText);
      continue;
    }

    lineRange = mergeLineRange(
      lineRange,
      newContent,
      match.startIndex,
      edit.newText
    );
    newContent = replaceEditMatch(newContent, match, edit.newText);
    appliedEdits += 1;
  }

  return finalizeEditResult(
    content,
    newContent,
    appliedEdits,
    unmatchedEdits,
    lineRange
  );
}

export async function handleEditFile(
  args: EditInput,
  signal?: AbortSignal
): Promise<ToolResponse<EditOutput>> {
  const { validPath, content } = await loadEditableFile(args.path, signal);
  const editResult = applyEdits(content, args.edits, args.ignoreWhitespace);
  const structured = buildStructuredEditOutput(validPath, editResult);

  if (args.dryRun) {
    if (editResult.appliedEdits > 0) {
      structured.diff = buildDiff(validPath, content, editResult.content);
    }

    return buildToolResponse(
      `Dry run complete. ${editResult.appliedEdits} edits would be applied.`,
      structured
    );
  }

  if (editResult.appliedEdits > 0) {
    await atomicWriteFile(validPath, editResult.content, {
      encoding: 'utf-8',
      signal,
    });
  }

  return buildToolResponse(buildEditMessage(args.path, editResult), structured);
}

export function registerEditFileTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: EditInput,
    extra: ToolExtra
  ): Promise<ToolResult<EditOutput>> =>
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
    progressMessage: buildEditProgressMessage,
    completionMessage: buildEditCompletionMessage,
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
