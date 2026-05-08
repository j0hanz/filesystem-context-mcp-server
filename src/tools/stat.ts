import type { Stats } from 'node:fs';
import { readlink, stat } from 'node:fs/promises';
import { parse } from 'node:path';

import type { z } from 'zod/v4';

import { assertNotAborted, withAbort } from '../lib/abort.js';
import { DEFAULT_SEARCH_TIMEOUT_MS, getMimeType } from '../lib/constants.js';
import { ErrorCode, isAbortError } from '../lib/errors.js';
import { getFileType, isHidden } from '../lib/fs-walk.js';
import {
  assertAllowedFileAccess,
  validateExistingPathDetailed,
} from '../lib/paths.js';
import { StatInputSchema } from '../schemas/inputs.js';
import { StatOutputSchema } from '../schemas/outputs.js';

import { type FileInfo, formatBytes, joinLines } from '../config.js';
import {
  buildPathMessages,
  defineTool,
  type ToolRunContext,
} from './define-tool.js';
import { FILE_READ_ICONS } from './icons.js';
import {
  buildFileInfoPayload,
  buildToolResponse,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolContract,
} from './shared.js';

const GET_FILE_INFO_TOOL: ToolContract = {
  name: 'stat',
  title: 'Get File Info',
  description:
    'Get file/directory metadata: size, modified, permissions, mime, tokenEstimate. ' +
    'Use `tokenEstimate` (size\u00f74) to pre-screen token cost before reading.',
  inputSchema: StatInputSchema,
  outputSchema: StatOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: FILE_READ_ICONS,
  taskSupport: 'forbidden',
  defaultTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
} as const;

const PERM_STRINGS = [
  '---',
  '--x',
  '-w-',
  '-wx',
  'r--',
  'r-x',
  'rw-',
  'rwx',
] as const satisfies readonly string[];

function getPermissions(mode: number): string {
  return (
    (PERM_STRINGS[(mode >> 6) & 0b111] ?? '---') +
    (PERM_STRINGS[(mode >> 3) & 0b111] ?? '---') +
    (PERM_STRINGS[mode & 0b111] ?? '---')
  );
}

function buildFileInfoResult(
  name: string,
  requestedPath: string,
  isSymlink: boolean,
  stats: Stats,
  mimeType: string | undefined,
  symlinkTarget: string | undefined
): FileInfo {
  const tokenEstimate = stats.isFile() ? Math.ceil(stats.size / 4) : undefined;
  return {
    name,
    path: requestedPath,
    type: isSymlink ? 'symlink' : getFileType(stats),
    size: stats.size,
    ...(tokenEstimate !== undefined ? { tokenEstimate } : {}),
    created: stats.birthtime,
    modified: stats.mtime,
    accessed: stats.atime,
    permissions: getPermissions(stats.mode),
    isHidden: isHidden(name),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(symlinkTarget !== undefined ? { symlinkTarget } : {}),
  };
}

async function getSymlinkTarget(
  pathToRead: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  assertNotAborted(signal);
  try {
    return await withAbort(readlink(pathToRead), signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

interface FileInfoOptions {
  includeMimeType?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

async function getFileInfo(
  filePath: string,
  options: FileInfoOptions = {}
): Promise<FileInfo> {
  const { signal } = options;
  assertNotAborted(signal);

  const { requestedPath, resolvedPath, isSymlink } =
    await validateExistingPathDetailed(filePath, signal);

  assertAllowedFileAccess(requestedPath, resolvedPath);

  const { base: name, ext: rawExt } = parse(requestedPath);
  const ext = rawExt.toLowerCase();
  const includeMimeType = options.includeMimeType !== false;
  const mimeType =
    includeMimeType && ext.length > 0 ? getMimeType(ext) : undefined;

  const symlinkTarget = isSymlink
    ? await getSymlinkTarget(requestedPath, signal)
    : undefined;

  const stats = await withAbort(stat(resolvedPath), signal);

  return buildFileInfoResult(
    name,
    requestedPath,
    isSymlink,
    stats,
    mimeType,
    symlinkTarget
  );
}

function formatFileInfoDetails(info: FileInfo): string {
  const lines = [
    `${info.name} (${info.type})`,
    `  Path: ${info.path}`,
    `  Size: ${formatBytes(info.size)}`,
    `  Modified: ${info.modified.toISOString()}`,
  ];

  if (info.mimeType) lines.push(`  Type: ${info.mimeType}`);
  if (info.symlinkTarget) lines.push(`  Target: ${info.symlinkTarget}`);

  return joinLines(lines);
}

type StatInput = z.infer<typeof StatInputSchema>;
type StatOutput = z.infer<typeof StatOutputSchema>;

const statMessages = buildPathMessages<StatInput, StatOutput>(
  GET_FILE_INFO_TOOL.title,
  (sc) => `${sc.file.name} \u2022 ${formatBytes(sc.file.size)}`
);

export const GET_FILE_INFO = defineTool<StatInput, StatOutput>({
  contract: GET_FILE_INFO_TOOL,
  run: async (args, ctx: ToolRunContext) => {
    const info = await getFileInfo(args.path, {
      includeMimeType: true,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    const structured: z.infer<typeof StatOutputSchema> = {
      ok: true,
      file: buildFileInfoPayload(info),
    };

    return buildToolResponse(formatFileInfoDetails(info), structured);
  },
  defaultErrorCode: ErrorCode.NOT_FOUND,
  ...statMessages,
});
