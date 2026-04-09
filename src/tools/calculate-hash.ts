import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type BinaryToTextEncoding, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import type { z } from 'zod';

import { assertNotAborted, withAbort } from '../lib/abort.js';
import { PARALLEL_CONCURRENCY } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import {
  isIgnoredByGitignore,
  loadRootGitignore,
} from '../lib/file-operations/core.js';
import { globEntries } from '../lib/file-operations/traversal.js';
import { validateExistingPath } from '../lib/paths.js';

import {
  CalculateHashInputSchema,
  CalculateHashOutputSchema,
} from '../schemas.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  createToolProgressSession,
  executeToolWithDiagnostics,
  READ_ONLY_TOOL_ANNOTATIONS,
  resolveFinalProgressCurrent,
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

const WINDOWS_PATH_SEPARATOR = /\\/gu;

export const CALCULATE_HASH_TOOL: ToolContract = {
  name: 'calculate_hash',
  title: 'Calculate Hash',
  description: 'Calculate SHA-256 hash of a file or directory.',
  inputSchema: CalculateHashInputSchema,
  outputSchema: CalculateHashOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  nuances: [
    'Directory hashing respects root `.gitignore` and sorts paths for stable output.',
  ],
  taskSupport: 'optional',
} as const;

async function hashFile(
  filePath: string,
  encoding: BinaryToTextEncoding,
  signal?: AbortSignal
): Promise<string>;
async function hashFile(
  filePath: string,
  encoding: undefined,
  signal?: AbortSignal
): Promise<Buffer>;
async function hashFile(
  filePath: string,
  encoding: BinaryToTextEncoding | undefined,
  signal?: AbortSignal
): Promise<string | Buffer> {
  const hasher = createHash('sha256');
  await pipeline(
    createReadStream(filePath, { signal, highWaterMark: 64 * 1024 }),
    hasher,
    { signal }
  );
  return encoding ? hasher.digest(encoding) : hasher.digest();
}

function toStableRelativePath(root: string, entryPath: string): string {
  const relativePath = path.relative(root, entryPath);
  return relativePath.includes(path.win32.sep)
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
      const fileHash = await hashFile(task.filePath, undefined, signal);
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
  args: z.infer<typeof CalculateHashInputSchema>,
  signal?: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<ToolResponse<z.infer<typeof CalculateHashOutputSchema>>> {
  const validPath = await validateExistingPath(args.path, signal);

  // Check if path is a directory or file
  const stats = await withAbort(fs.stat(validPath), signal);

  if (stats.isDirectory()) {
    // Hash directory: composite hash of all files
    const { hash, fileCount } = await hashDirectory(validPath, {
      ...(signal ? { signal } : {}),
      ...(onProgress ? { onProgress } : {}),
    });

    return buildToolResponse(`${hash} (${fileCount} files)`, {
      ok: true,
      path: validPath,
      hash,
      isDirectory: true,
      fileCount,
    });
  } else {
    // Hash single file
    const hash = await hashFile(validPath, 'hex', signal);
    onProgress?.({ current: 1 });

    return buildToolResponse(hash, {
      ok: true,
      path: validPath,
      hash,
      isDirectory: false,
    });
  }
}

export function registerCalculateHashTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof CalculateHashInputSchema>,
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof CalculateHashOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'calculate_hash',
      extra,
      outputSchema: CalculateHashOutputSchema,
      timedSignal: {},
      context: { path: args.path },
      run: async (signal) => {
        const baseName = path.basename(args.path);
        const progress = createToolProgressSession(
          extra,
          `🕮 hash: ${baseName}`
        );
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
            message: `🕮 hash: ${baseName} [${current} files]`,
          });
        };

        try {
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
          let suffix: string;
          if (sc.fileCount !== undefined && sc.fileCount > 1) {
            suffix = `${sc.fileCount} files • ${(sc.hash ?? '').slice(0, 8)}…`;
          } else {
            suffix = `${(sc.hash ?? '').slice(0, 8)}…`;
          }
          progress.complete(`🕮 hash: ${baseName} • ${suffix}`, finalCurrent);
          return result;
        } catch (error) {
          progress.fail(`🕮 hash: ${baseName} • failed`);
          throw error;
        }
      },
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.UNKNOWN, args.path),
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
  });

  const validatedHandler = withValidatedArgs(
    CalculateHashInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      'calculate_hash',
      CALCULATE_HASH_TOOL,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  )
    return;
  server.registerTool(
    'calculate_hash',
    withDefaultIcons({ ...CALCULATE_HASH_TOOL }, options.iconInfo),
    validatedHandler
  );
}
