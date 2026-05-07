import type { McpServer } from '@modelcontextprotocol/server';

import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, relative, win32 } from 'node:path';

import type { z } from 'zod/v4';

import { assertNotAborted, withAbort } from '../lib/abort.js';
import { PARALLEL_CONCURRENCY } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import {
  isIgnoredByGitignore,
  loadRootGitignore,
} from '../lib/file-operations/core.js';
import { globEntries } from '../lib/file-operations/traversal.js';
import { calculateFileContentHash } from '../lib/fs-helpers.js';
import { validateExistingPath } from '../lib/paths.js';
import { HashInputSchema } from '../schemas/inputs.js';
import { HashOutputSchema } from '../schemas/outputs.js';

import { FILE_READ_ICONS } from './icons.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  executeToolWithDiagnostics,
  READ_ONLY_TOOL_ANNOTATIONS,
  resolveFinalProgressCurrent,
  runWithProgressSession,
  type ToolContext,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
} from './shared.js';
import { registerStandardTool } from './task-support.js';

const WINDOWS_PATH_SEPARATOR = /\\/gu;

export const CALCULATE_HASH_TOOL: ToolContract = {
  name: 'calculate_hash',
  title: 'Calculate Hash',
  description: 'Calculate SHA-256 hash of a file or directory.',
  inputSchema: HashInputSchema,
  outputSchema: HashOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: FILE_READ_ICONS,
  nuances: [
    'Directory hashing respects root `.gitignore` and sorts paths for stable output.',
  ],
  taskSupport: 'optional',
} as const;

function toStableRelativePath(root: string, entryPath: string): string {
  const relativePath = relative(root, entryPath);
  return relativePath.includes(win32.sep)
    ? relativePath.replace(WINDOWS_PATH_SEPARATOR, '/')
    : relativePath;
}

function comparePaths(left: { path: string }, right: { path: string }): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function updateCompositeHash(
  hasher: ReturnType<typeof createHash>,
  pathLengthBytes: Buffer,
  relativePath: string,
  fileHash: Buffer
): void {
  const relativePathBytes = Buffer.from(relativePath, 'utf8');
  pathLengthBytes.writeUInt32BE(relativePathBytes.length, 0);

  hasher.update(pathLengthBytes);
  hasher.update(relativePathBytes);
  hasher.update(fileHash);
}

async function hashDirectory(
  dirPath: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: { total?: number; current: number }) => void;
  } = {}
): Promise<{ hash: string; fileCount: number }> {
  const { signal, onProgress } = options;
  const gitignoreMatcher = await loadRootGitignore(dirPath, signal);

  // Phase 1: collect all file paths that pass gitignore filtering.
  const filteredPaths: { filePath: string; relativePath: string }[] = [];

  for await (const entry of globEntries({
    cwd: dirPath,
    pattern: '**/*',
    excludePatterns: [],
    includeHidden: false,
    baseNameMatch: false,
    caseSensitiveMatch: true,
    followSymbolicLinks: false,
    onlyFiles: true,
    stats: false,
    suppressErrors: true,
  })) {
    assertNotAborted(signal);
    if (
      gitignoreMatcher &&
      isIgnoredByGitignore(gitignoreMatcher, dirPath, entry.path)
    ) {
      continue;
    }
    filteredPaths.push({
      filePath: entry.path,
      relativePath: toStableRelativePath(dirPath, entry.path),
    });
  }

  assertNotAborted(signal);

  const concurrency = Math.min(PARALLEL_CONCURRENCY, 8);
  const entries: { path: string; hash: Buffer }[] = [];
  let filesHashed = 0;
  const totalFiles = filteredPaths.length;
  const taskQueue = filteredPaths;

  const worker = async (): Promise<void> => {
    while (taskQueue.length > 0) {
      const task = taskQueue.pop();
      if (!task) break;

      assertNotAborted(signal);
      const fileHash = await calculateFileContentHash(
        task.filePath,
        signal,
        null
      );
      entries.push({ path: task.relativePath, hash: fileHash });

      filesHashed++;
      onProgress?.({ current: filesHashed, total: totalFiles });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  onProgress?.({ current: filesHashed, total: totalFiles });

  assertNotAborted(signal);
  // Sort by path with byte-wise semantics for deterministic ordering.
  entries.sort(comparePaths);

  // Create composite hash using length-delimited paths and binary digests.
  const compositeHasher = createHash('sha256');
  const pathLengthBytes = Buffer.allocUnsafe(4);
  for (const { path: filePath, hash: fileHash } of entries) {
    updateCompositeHash(compositeHasher, pathLengthBytes, filePath, fileHash);
    assertNotAborted(signal);
  }

  return {
    hash: compositeHasher.digest('hex'),
    fileCount: entries.length,
  };
}

async function handleCalculateHash(
  args: z.infer<typeof HashInputSchema>,
  signal?: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<ToolResponse<z.infer<typeof HashOutputSchema>>> {
  const validPath = await validateExistingPath(args.path ?? '', signal);

  // Check if path is a directory or file
  const stats = await withAbort(stat(validPath), signal);

  if (stats.isDirectory()) {
    const { hash, fileCount } = await hashDirectory(validPath, {
      ...(signal ? { signal } : {}),
      ...(onProgress ? { onProgress } : {}),
    });

    return buildToolResponse(`${hash} (${fileCount} files)`, {
      ok: true,
      hash,
      path: validPath,
      isDirectory: true,
      fileCount,
    });
  } else {
    const hash = await calculateFileContentHash(validPath, signal);
    onProgress?.({ current: 1 });

    return buildToolResponse(hash, {
      ok: true,
      hash,
      path: validPath,
      isDirectory: false,
    });
  }
}

export function registerCalculateHashTool(
  server: McpServer,
  options: ToolRegistrationOptions
): void {
  const handler = (
    args: z.infer<typeof HashInputSchema>,
    ctx: ToolContext
  ): Promise<ToolResult<z.infer<typeof HashOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'calculate_hash',
      ctx,
      outputSchema: HashOutputSchema,
      timedSignal: {},
      context: { path: args.path },
      run: async (signal) => {
        const baseName = basename(args.path ?? '');
        const label = `${CALCULATE_HASH_TOOL.title}: ${baseName}`;
        return runWithProgressSession(ctx, label, async (progress) => {
          const progressWithMessage = ({
            current,
            total,
          }: {
            total?: number;
            current: number;
          }): void => {
            progress.update({
              current,
              ...(total !== undefined ? { total } : {}),
              message: `${label} [${current} files]`,
            });
          };

          const result = await handleCalculateHash(
            args,
            signal,
            progressWithMessage
          );
          const sc = result.structuredContent;
          const totalFiles = sc.fileCount ?? 1;
          const finalCurrent = resolveFinalProgressCurrent(
            progress,
            totalFiles + 1
          );
          const suffix =
            sc.fileCount !== undefined && sc.fileCount > 1
              ? `${sc.fileCount} files • ${sc.hash.slice(0, 8)}…`
              : `${sc.hash.slice(0, 8)}…`;
          return { value: result, suffix, finalCurrent };
        });
      },
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.UNKNOWN, args.path),
    });

  registerStandardTool(server, CALCULATE_HASH_TOOL, handler, options);
}
