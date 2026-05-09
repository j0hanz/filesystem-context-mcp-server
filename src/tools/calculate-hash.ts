import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, relative, win32 } from 'node:path';

import { z } from 'zod/v4';

import { assertNotAborted, withAbort } from '../core/concurrency.js';
import { DEFAULT_SEARCH_TIMEOUT_MS, PARALLEL_CONCURRENCY } from '../core/util.js';
import { ErrorCode } from '../core/errors.js';
import { calculateFileContentHash } from '../core/fs.js';
import { globEntries, isIgnoredByGitignore, loadRootGitignore } from '../core/fs.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { NonNegInt, RequiredPath } from '../schemas/fields.js';

import { defineTool } from './define-tool.js';
import { FILE_READ_ICONS } from './icons.js';
import {
  buildResourceResponse,
  putResource,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolContract,
  type ToolResponse,
} from './shared.js';
import { resolveFinalProgressCurrent, runWithProgressSession } from './tool-execution.js';

const WINDOWS_PATH_SEPARATOR = /\\/gu;

const SUPPORTED_ALGORITHMS = ['sha256', 'md5', 'sha1', 'sha512'] as const;

const HashInputSchema = z.strictObject({
  path: RequiredPath,
  algorithms: z
    .array(z.enum(SUPPORTED_ALGORITHMS))
    .optional()
    .default(['sha256'])
    .describe('Hash algorithms to compute (default: sha256)'),
});

const HashOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  filePath: z.string().describe('Resolved file or directory path'),
  algorithms: z.array(z.enum(SUPPORTED_ALGORITHMS)).describe('Algorithms computed'),
  hashes: z.record(z.string(), z.string()).describe('Algorithm → hex digest mapping'),
  resourceUri: z.string().describe('URI to hashes.json resource'),
  isDirectory: z.boolean().describe('True when hashing a directory'),
  fileCount: NonNegInt.optional().describe('Files hashed (directories only)'),
});

const CALCULATE_HASH_TOOL: ToolContract = {
  name: 'calculate_hash',
  title: 'Calculate Hash',
  description: 'Calculate SHA-256, MD5, or other hashes for a file or directory.',
  inputSchema: HashInputSchema,
  outputSchema: HashOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: FILE_READ_ICONS,
  nuances: [
    'Directory hashing respects root `.gitignore` and sorts paths for stable output.',
    'Hidden files (names starting with `.`) are excluded from directory hashing.',
    'Supported algorithms: sha256, md5, sha1, sha512.',
  ],
  taskSupport: 'optional',
  defaultTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
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

async function calculateMultipleHashes(
  filePath: string,
  algorithms: readonly (typeof SUPPORTED_ALGORITHMS)[number][],
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const { createReadStream } = await import('node:fs');
  const { PassThrough } = await import('node:stream');
  const { pipeline: streamPipeline } = await import('node:stream/promises');

  const hashers = new Map<(typeof SUPPORTED_ALGORITHMS)[number], ReturnType<typeof createHash>>();
  for (const algo of algorithms) {
    hashers.set(algo, createHash(algo));
  }

  const splitter = new PassThrough();
  // Each hasher + pipeline adds multiple listeners for internal events
  splitter.setMaxListeners(algorithms.length * 3 + 10);

  // Create pipeline that feeds the file into all hashers
  const hashPromises = Array.from(hashers.values()).map((hasher) =>
    streamPipeline(splitter, hasher, { signal }),
  );

  const readStream = createReadStream(filePath, {
    signal,
    highWaterMark: 64 * 1024,
  });

  // Feed file data to splitter, which feeds it to all hashers
  await streamPipeline(readStream, splitter, { signal });

  // Wait for all hashers to finish
  await Promise.all(hashPromises);

  const hashes: Record<string, string> = {};
  for (const [algo, hasher] of hashers) {
    hashes[algo] = hasher.digest('hex');
  }

  return hashes;
}

function updateCompositeHash(
  hasher: ReturnType<typeof createHash>,
  pathLengthBytes: Buffer,
  relativePath: string,
  fileHash: Buffer,
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
  } = {},
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
    if (gitignoreMatcher && isIgnoredByGitignore(gitignoreMatcher, dirPath, entry.path)) {
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
      const fileHash = await calculateFileContentHash(task.filePath, signal, null);
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
  pathGuard: PathGuard,
  resourceStore: ResourceStore | undefined,
  signal?: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void,
): Promise<ToolResponse<z.infer<typeof HashOutputSchema>>> {
  const validPath = await pathGuard.validateExistingPath(args.path);
  const { algorithms } = args;

  // Check if path is a directory or file
  const stats = await withAbort(stat(validPath), signal);

  let hashes: Record<string, string>;
  let fileCount: number | undefined;

  if (stats.isDirectory()) {
    // For directories, we compute SHA-256 of directory contents
    // and add it to the hashes map
    const { hash, fileCount: count } = await hashDirectory(validPath, {
      ...(signal ? { signal } : {}),
      ...(onProgress ? { onProgress } : {}),
    });
    hashes = { sha256: hash };
    fileCount = count;
  } else {
    // For files, calculate requested algorithms
    hashes = await calculateMultipleHashes(validPath, algorithms, signal);
    onProgress?.({ current: 1 });
  }

  // Store hashes as JSON - resourceStore should always be available
  if (!resourceStore) {
    throw new Error('Resource store is required for calculate_hash tool');
  }

  const hashJson = JSON.stringify(hashes, null, 2);
  const { link, entry } = putResource({
    store: resourceStore,
    name: 'hashes.json',
    mimeType: 'application/json',
    kind: 'text',
    content: hashJson,
  });

  // Format summary with primary algorithm and truncated hash
  const primaryAlgo = algorithms[0] ?? 'sha256';
  const primaryHash = hashes[primaryAlgo] ?? '';
  const displayAlgo =
    primaryAlgo === 'sha256'
      ? 'SHA-256'
      : primaryAlgo === 'sha512'
        ? 'SHA-512'
        : primaryAlgo === 'sha1'
          ? 'SHA-1'
          : primaryAlgo.toUpperCase();
  const hashDisplay = primaryHash.length > 16 ? `${primaryHash.slice(0, 16)}…` : primaryHash;
  const fileName = basename(validPath);
  const summary = `calculate-hash: ${fileName} · ${displayAlgo}: ${hashDisplay}`;

  return buildResourceResponse({
    summary,
    resources: [link],
    structured: {
      ok: true,
      filePath: validPath,
      algorithms: [...algorithms],
      hashes,
      resourceUri: entry.uri,
      isDirectory: stats.isDirectory(),
      ...(fileCount !== undefined ? { fileCount } : {}),
    },
  });
}

export const CALCULATE_HASH = defineTool<
  z.infer<typeof HashInputSchema>,
  z.infer<typeof HashOutputSchema>
>({
  contract: CALCULATE_HASH_TOOL,
  defaultErrorCode: ErrorCode.UNKNOWN,
  run: async (args, ctx) => {
    const baseName = basename(args.path);
    const label = `${CALCULATE_HASH_TOOL.title}: ${baseName}`;
    return runWithProgressSession<ToolResponse<z.infer<typeof HashOutputSchema>>>(
      ctx,
      label,
      async (progress) => {
        const onProgress = ({ current, total }: { total?: number; current: number }): void => {
          progress.set({
            current,
            ...(total !== undefined ? { total } : {}),
            message: `${label} [${current} files]`,
          });
        };

        const result = await handleCalculateHash(
          args,
          ctx.pathGuard,
          ctx.resourceStore,
          ctx.signal,
          onProgress,
        );
        const sc = result.structuredContent;
        const totalFiles = sc.fileCount ?? 1;
        const finalCurrent = resolveFinalProgressCurrent(progress, totalFiles + 1);
        const primaryAlgo = args.algorithms[0] ?? 'sha256';
        const primaryHash = sc.hashes[primaryAlgo] ?? '';
        const suffix =
          sc.fileCount !== undefined && sc.fileCount > 1
            ? `${sc.fileCount} files • ${primaryHash.slice(0, 8)}…`
            : `${primaryHash.slice(0, 8)}…`;
        return { value: result, suffix, finalCurrent };
      },
    );
  },
});


