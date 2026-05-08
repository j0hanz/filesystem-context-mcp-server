import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { formatPatch, structuredPatch, type StructuredPatch } from 'diff';
import { z } from 'zod/v4';

import { withAbort } from '../lib/abort.js';
import { MAX_TEXT_FILE_SIZE } from '../lib/constants.js';
import { ErrorCode, McpError } from '../lib/errors.js';
import type { PathGuard } from '../lib/path-guard.js';
import { runInWorker, shouldOffload } from '../lib/worker-pool.js';
import { NonNegInt, RequiredPath } from '../schemas/fields.js';
import { defaultFalseBoolean } from '../schemas/shared.js';

import { defineTool } from './define-tool.js';
import { FILE_READ_ICONS } from './icons.js';
import {
  buildResourceLink,
  buildToolResponse,
  maybeExternalizeTextContent,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
} from './shared.js';

const DiffFilesInputSchema = z.strictObject({
  original: RequiredPath.describe('Original file path'),
  modified: RequiredPath.describe('Modified file path'),
  context: z.int32().min(0).optional().describe('Context lines (default 3)'),
  ignoreWhitespace: defaultFalseBoolean('Ignore whitespace changes'),
  stripTrailingCr: defaultFalseBoolean('Strip trailing carriage returns'),
});

const DiffFilesOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  diff: z.string().describe('Unified diff output (empty when identical)'),
  isIdentical: z.boolean().describe('True when files are identical'),
  stats: z
    .strictObject({
      additions: NonNegInt.describe('Lines added'),
      deletions: NonNegInt.describe('Lines deleted'),
      hunks: NonNegInt.describe('Hunk count'),
    })
    .optional()
    .describe('Diff statistics (absent when identical)'),
  truncated: z.boolean().optional().describe('Diff was truncated to resource'),
  resourceUri: z.string().optional().describe('Full diff URI when truncated'),
});

const DIFF_FILES_TOOL: ToolContract = {
  name: 'diff_files',
  title: 'Diff Files',
  description:
    'Generate a unified diff between two files. ' +
    'Output feeds directly into `apply_patch`. ' +
    '`isIdentical=true` means files match \u2014 no patch needed.',
  inputSchema: DiffFilesInputSchema,
  outputSchema: DiffFilesOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: FILE_READ_ICONS,
  taskSupport: 'optional',
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
  pathGuard: PathGuard,
  signal?: AbortSignal,
  resourceStore?: ToolRegistrationOptions['resourceStore']
): Promise<ToolResponse<z.infer<typeof DiffFilesOutputSchema>>> {
  const originalInput = args.original;
  const modifiedInput = args.modified;

  const [originalPath, modifiedPath] = await Promise.all([
    pathGuard.validateExistingPath(originalInput),
    pathGuard.validateExistingPath(modifiedInput),
  ]);

  const [originalStats, modifiedStats] = await Promise.all([
    withAbort(stat(originalPath), signal),
    withAbort(stat(modifiedPath), signal),
  ]);

  assertDiffFileSizeWithinLimit(
    originalPath,
    originalStats.size,
    MAX_TEXT_FILE_SIZE
  );
  assertDiffFileSizeWithinLimit(
    modifiedPath,
    modifiedStats.size,
    MAX_TEXT_FILE_SIZE
  );

  const [originalContent, modifiedContent] = await Promise.all([
    readFile(originalPath, { encoding: 'utf-8', signal }),
    readFile(modifiedPath, { encoding: 'utf-8', signal }),
  ]);

  const totalBytes = originalStats.size + modifiedStats.size;

  const patchObj = shouldOffload(totalBytes)
    ? await runInWorker(
        'diff',
        {
          oldStr: originalContent,
          newStr: modifiedContent,
          oldHeader: basename(originalPath),
          newHeader: basename(modifiedPath),
          ...(args.context !== undefined ? { context: args.context } : {}),
          ...(args.ignoreWhitespace
            ? { ignoreWhitespace: args.ignoreWhitespace }
            : {}),
          ...(args.stripTrailingCr
            ? { stripTrailingCr: args.stripTrailingCr }
            : {}),
        },
        signal ? { signal } : {}
      )
    : await new Promise<StructuredPatch | undefined>((resolve) => {
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
  const rawStats = isIdentical ? undefined : computeDiffStats(patchObj.hunks);
  const mappedStats = rawStats
    ? {
        additions: rawStats.linesAdded,
        deletions: rawStats.linesRemoved,
        hunks: rawStats.hunksCount,
      }
    : undefined;

  const externalized = maybeExternalizeTextContent(resourceStore, diffText, {
    name: 'diff:patch',
    mimeType: 'text/x-diff',
  });

  if (!externalized) {
    return buildToolResponse(isIdentical ? 'No differences' : diffText, {
      ok: true,
      diff: diffText,
      isIdentical,
      ...(mappedStats ? { stats: mappedStats } : {}),
    });
  }

  const { preview, entry } = externalized;
  return buildToolResponse(
    preview,
    {
      ok: true,
      diff: preview,
      isIdentical,
      ...(mappedStats ? { stats: mappedStats } : {}),
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

type DiffInput = z.infer<typeof DiffFilesInputSchema>;
type DiffOutput = z.infer<typeof DiffFilesOutputSchema>;

export const DIFF_FILES = defineTool<DiffInput, DiffOutput>({
  contract: DIFF_FILES_TOOL,
  defaultErrorCode: ErrorCode.UNKNOWN,
  diagnosticsContext: (args) => ({ path: args.original }),
  run: (args, ctx) =>
    handleDiffFiles(args, ctx.pathGuard, ctx.signal, ctx.resourceStore),
  progressMessage: (args) => {
    const n1 = basename(args.original);
    const n2 = basename(args.modified);
    return `${DIFF_FILES_TOOL.title}: ${n1} ⟷ ${n2}`;
  },
  completionMessage: (
    args: DiffInput,
    result: ToolResult<DiffOutput>
  ): string => {
    const n1 = basename(args.original);
    const n2 = basename(args.modified);
    if (result.isError)
      return `${DIFF_FILES_TOOL.title}: ${n1} ⟷ ${n2} • ${result.errorCode}`;
    const sc = result.structuredContent;
    if (sc.isIdentical)
      return `${DIFF_FILES_TOOL.title}: ${n1} ⟷ ${n2} • identical`;
    const added = sc.stats?.additions ?? 0;
    const removed = sc.stats?.deletions ?? 0;
    if (added > 0 || removed > 0)
      return `${DIFF_FILES_TOOL.title}: ${n1} ⟷ ${n2} • +${added} -${removed}`;
    return `${DIFF_FILES_TOOL.title}: ${n1} ⟷ ${n2}`;
  },
});
