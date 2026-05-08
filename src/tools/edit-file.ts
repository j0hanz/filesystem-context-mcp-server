import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { createTwoFilesPatch, diffLines } from 'diff';
import RE2 from 're2';
import { z } from 'zod/v4';

import { withAbort } from '../lib/abort.js';
import { atomicWriteFile } from '../lib/atomic-write.js';
import { MAX_TEXT_FILE_SIZE } from '../lib/constants.js';
import { ErrorCode, McpError } from '../lib/errors.js';
import { readFileWithStats } from '../lib/file-content.js';
import { Logger } from '../lib/logger.js';
import type { PathGuard } from '../lib/path-guard.js';
import { runInWorker, shouldOffload } from '../lib/worker-pool.js';
import { NonNegInt, PositiveInt, RequiredPath } from '../schemas/fields.js';
import { defaultFalseBoolean } from '../schemas/shared.js';

import { defineTool } from './define-tool.js';
import { FILE_EDIT_ICONS } from './icons.js';
import {
  buildToolResponse,
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  type ToolContract,
  type ToolResult,
} from './shared.js';

const EditFileInputSchema = z.strictObject({
  path: RequiredPath,
  edits: z
    .array(
      z.strictObject({
        oldText: z
          .string()
          .min(1, 'oldText required')
          .describe('Exact text to find (must match literally)')
          .meta({ examples: ['const x = 1;', 'function oldName('] }),
        newText: z
          .string()
          .describe('Replacement text (empty string to delete)')
          .meta({ examples: ['const x = 2;', 'function newName(', ''] }),
      })
    )
    .min(1)
    .describe('List of text substitutions'),
  dryRun: defaultFalseBoolean('Preview changes without writing'),
  ignoreWhitespace: defaultFalseBoolean(
    'Ignore leading/trailing whitespace when matching'
  ),
});

const EditFileOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  path: z.string().describe('File path'),
  appliedEdits: NonNegInt.describe('Edits applied'),
  linesAdded: NonNegInt.optional().describe('Lines added'),
  linesRemoved: NonNegInt.optional().describe('Lines removed'),
  diff: z.string().optional().describe('Unified diff of changes'),
  unmatchedEdits: z
    .array(z.string())
    .optional()
    .describe('oldText strings that had no match'),
  lineRange: z
    .tuple([PositiveInt, PositiveInt])
    .optional()
    .describe('[firstLine, lastLine] range modified'),
});

const EDIT_FILE_TOOL: ToolContract = {
  name: 'edit',
  title: 'Edit File',
  description:
    'Apply sequential literal string replacements to a file (first occurrence per edit). ' +
    '`oldText` must match exactly — include 3–5 lines of context for unique targeting. ' +
    'Use `dryRun:true` to preview.',
  inputSchema: EditFileInputSchema,
  outputSchema: EditFileOutputSchema,
  annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  icons: FILE_EDIT_ICONS,
  nuances: ['Each edit applies to the output of the previous edit.'],
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

async function computeDiffStats(
  original: string,
  modified: string
): Promise<{ linesAdded: number; linesRemoved: number }> {
  return new Promise((resolve) => {
    diffLines(original, modified, {
      callback: (changes) => {
        let linesAdded = 0;
        let linesRemoved = 0;

        for (const part of changes) {
          if (part.added) {
            linesAdded += part.count;
          } else if (part.removed) {
            linesRemoved += part.count;
          }
        }

        resolve({ linesAdded, linesRemoved });
      },
    });
  });
}

function findEditMatch(
  content: string,
  oldText: string,
  ignoreWhitespace: boolean,
  regexCache?: Map<string, RE2>
): TextRange | undefined {
  if (ignoreWhitespace) {
    const pattern = escapeRegExp(oldText).replace(/\s+/g, '\\s+');
    let regex = regexCache?.get(pattern);
    if (!regex) {
      regex = new RE2(pattern);
      if (regexCache) regexCache.set(pattern, regex);
    }
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
    ok: true as const,
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

async function finalizeEditResult(
  originalContent: string,
  updatedContent: string,
  appliedEdits: number,
  unmatchedEdits: string[],
  lineRange: EditResult['lineRange']
): Promise<EditResult> {
  const { linesAdded, linesRemoved } =
    appliedEdits > 0
      ? await computeDiffStats(originalContent, updatedContent)
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

async function buildDiff(
  validPath: string,
  original: string,
  modified: string
): Promise<string> {
  const fileName = basename(validPath);
  const totalBytes = Buffer.byteLength(original) + Buffer.byteLength(modified);
  if (shouldOffload(totalBytes)) {
    const result = await runInWorker('diffLines', {
      oldStr: original,
      newStr: modified,
      oldHeader: fileName,
      newHeader: fileName,
    });
    return result.unifiedDiff;
  }
  return new Promise<string>((resolve) => {
    createTwoFilesPatch(
      fileName,
      fileName,
      original,
      modified,
      'Original',
      'Modified',
      {
        callback: (res: string | undefined) => {
          resolve(res ?? '');
        },
      }
    );
  });
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
  pathGuard: PathGuard,
  signal?: AbortSignal
): Promise<{ validPath: string; content: string }> {
  const validPath = await pathGuard.validateExistingPath(requestedPath);
  pathGuard.assertAllowedFileAccess(requestedPath);
  const stats = await withAbort(stat(validPath), signal);

  if (stats.size > MAX_TEXT_FILE_SIZE) {
    throw new McpError(
      ErrorCode.TOO_LARGE,
      `File too large for edit (${stats.size} bytes > ${MAX_TEXT_FILE_SIZE} bytes)`,
      requestedPath,
      { size: stats.size, maxFileSize: MAX_TEXT_FILE_SIZE }
    );
  }

  const { content } = await readFileWithStats(
    requestedPath,
    validPath,
    stats,
    {
      encoding: 'utf-8',
      maxSize: MAX_TEXT_FILE_SIZE,
      skipBinary: true,
      ...(signal ? { signal } : {}),
    },
    pathGuard
  );
  return { validPath, content };
}

function buildEditProgressMessage(args: EditInput): string {
  const name = basename(args.path);
  const tag = args.dryRun ? ' [dry run]' : '';
  return `${EDIT_FILE_TOOL.title}: ${name}${tag}`;
}

function buildEditCompletionMessage(
  args: EditInput,
  result: ToolResult<EditOutput>
): string {
  const name = basename(args.path);
  if (result.isError)
    return `${EDIT_FILE_TOOL.title}: ${name} • ${result.errorCode}`;

  const { structuredContent } = result;
  if (
    structuredContent.appliedEdits === 0 &&
    (structuredContent.unmatchedEdits?.length ?? 0) > 0
  )
    return `${EDIT_FILE_TOOL.title}: ${name} • failed`;

  const applied = structuredContent.appliedEdits;
  if (applied === 0) return `${EDIT_FILE_TOOL.title}: ${name} • no changes`;

  const added = structuredContent.linesAdded ?? 0;
  const removed = structuredContent.linesRemoved ?? 0;
  const dry = args.dryRun ? 'dry run ' : '';
  return `${EDIT_FILE_TOOL.title}: ${name} • ${dry} +${added} -${removed}`;
}

async function applyEdits(
  content: string,
  edits: EditInput['edits'],
  ignoreWhitespace: boolean
): Promise<EditResult> {
  let newContent = content;
  let appliedEdits = 0;
  const unmatchedEdits: string[] = [];
  let lineRange: EditResult['lineRange'];
  const regexCache = ignoreWhitespace ? new Map<string, RE2>() : undefined;

  for (const edit of edits) {
    const match = findEditMatch(
      newContent,
      edit.oldText,
      ignoreWhitespace,
      regexCache
    );

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

async function handleEditFile(
  args: EditInput,
  pathGuard: PathGuard,
  signal?: AbortSignal
): Promise<z.infer<typeof EditFileOutputSchema>> {
  const { validPath, content } = await loadEditableFile(
    args.path,
    pathGuard,
    signal
  );
  const editResult = await applyEdits(
    content,
    args.edits,
    args.ignoreWhitespace
  );
  const structured = buildStructuredEditOutput(validPath, editResult);

  if (args.dryRun) {
    if (editResult.appliedEdits > 0) {
      structured.diff = await buildDiff(validPath, content, editResult.content);
    }

    return structured;
  }

  if (editResult.appliedEdits === 0 && editResult.unmatchedEdits.length > 0) {
    throw new McpError(
      ErrorCode.INVALID_INPUT,
      `All ${editResult.unmatchedEdits.length} edits failed. Verify oldText matches exact file content.`,
      args.path
    );
  }

  if (editResult.appliedEdits > 0) {
    await atomicWriteFile(validPath, editResult.content, {
      encoding: 'utf-8',
      signal,
    });
    Logger.info(
      `edit: ${args.path} (${editResult.appliedEdits} edits, +${editResult.linesAdded}/-${editResult.linesRemoved})`
    );
  }

  return structured;
}

export const EDIT_FILE = defineTool<EditInput, EditOutput>({
  contract: EDIT_FILE_TOOL,
  run: async (args, ctx) => {
    const structured = await handleEditFile(args, ctx.pathGuard, ctx.signal);
    const message = buildEditMessage(args.path, {
      appliedEdits: structured.appliedEdits,
      unmatchedEdits: structured.unmatchedEdits ?? [],
      content: '',
      linesAdded: structured.linesAdded ?? 0,
      linesRemoved: structured.linesRemoved ?? 0,
    });
    void ctx.log?.(
      'info',
      `edit: ${args.path} (${String(structured.appliedEdits)} edits)`,
      'edit'
    );
    return buildToolResponse(message, structured);
  },
  progressMessage: buildEditProgressMessage,
  completionMessage: buildEditCompletionMessage,
});
