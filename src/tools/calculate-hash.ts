import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BinaryToTextEncoding } from 'node:crypto';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { PARALLEL_CONCURRENCY } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import {
  isIgnoredByGitignore,
  loadRootGitignore,
} from '../lib/file-operations/gitignore.js';
import { globEntries } from '../lib/file-operations/glob-engine.js';
import { assertNotAborted, withAbort } from '../lib/fs-helpers.js';
import { validateExistingPath } from '../lib/path-validation.js';
import { reportPeriodicProgress } from '../lib/progress-reporting.js';

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
  assertNotAborted(signal);
  const hashOp = createHash('sha256');
  const stream = createReadStream(filePath, { signal });

  for await (const chunk of stream) {
    hashOp.update(chunk as Buffer | string);
    assertNotAborted(signal);
  }

  assertNotAborted(signal);
  return encoding === undefined ? hashOp.digest() : hashOp.digest(encoding);
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

  // Phase 2: hash files concurrently with bounded pool.
  const concurrency = Math.min(PARALLEL_CONCURRENCY, 8);
  const entries: { path: string; hash: Buffer }[] = [];
  let filesHashed = 0;

  for (let i = 0; i < filteredPaths.length; i += concurrency) {
    assertNotAborted(signal);
    const batch = filteredPaths.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async ({ filePath, relativePath }) => {
        const fileHash = await hashFile(filePath, undefined, signal);
        return { path: relativePath, hash: fileHash };
      })
    );
    entries.push(...batchResults);
    filesHashed += batchResults.length;
    reportPeriodicProgress(onProgress, filesHashed, { throttleModulo: 25 });
  }

  reportPeriodicProgress(onProgress, filesHashed, {
    throttleModulo: 25,
    force: true,
  });

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
    reportPeriodicProgress(onProgress, 1, {
      throttleModulo: 25,
      force: true,
    });

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
      timedSignal: {},
      context: { path: args.path },
      run: async (signal) => {
        const baseName = path.basename(args.path);
        const progress = createToolProgressSession(
          extra,
          `🕮 calculate_hash: ${baseName}`
        );
        const progressWithMessage = ({
          current,
          total,
        }: {
          total?: number;
          current: number;
        }): void => {
          const fileWord = current === 1 ? 'file' : 'files';
          progress.update({
            current,
            ...(total !== undefined ? { total } : {}),
            message: `🕮 calculate_hash: ${baseName} [${current} ${fileWord} hashed]`,
          });
        };

        try {
          const result = await handleCalculateHash(
            args,
            signal,
            progressWithMessage
          );
          const sc = result.structuredContent;
          const totalFiles = sc.ok ? (sc.fileCount ?? 1) : 1;
          const finalCurrent = resolveFinalProgressCurrent(
            progress,
            totalFiles + 1
          );
          let suffix: string;
          if (!sc.ok) {
            suffix = 'failed';
          } else if (sc.fileCount !== undefined && sc.fileCount > 1) {
            suffix = `${sc.fileCount} files • ${(sc.hash ?? '').slice(0, 8)}...`;
          } else {
            suffix = `${(sc.hash ?? '').slice(0, 8)}...`;
          }
          progress.complete(
            `🕮 calculate_hash: ${baseName} • ${suffix}`,
            finalCurrent
          );
          return result;
        } catch (error) {
          progress.fail(`🕮 calculate_hash: ${baseName} • failed`);
          throw error;
        }
      },
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.E_UNKNOWN, args.path),
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
