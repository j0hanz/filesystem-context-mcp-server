import { createHash } from 'node:crypto';
import { basename, relative, win32 } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { z } from 'zod/v4';

import { assertNotAborted } from '../core/concurrency.js';
import { ErrorCode, FsError, Problem } from '../core/errors.js';
import {
  globEntries,
  type GuardedFileSystem,
  isIgnoredByGitignore,
  loadRootGitignore,
} from '../core/fs.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { DEFAULT_SEARCH_TIMEOUT_MS, PARALLEL_CONCURRENCY } from '../core/util.js';
import { NonNegInt, RequiredPath } from '../schema.js';
import { putResource } from './_helpers.js';
import { defineTool } from './define.js';

const WINDOWS_PATH_SEPARATOR = /\\/gu;

const SUPPORTED_ALGORITHMS = ['sha256', 'md5', 'sha1', 'sha512'] as const;

const HashInputSchema = z.strictObject({
  path: RequiredPath,
  algorithms: z
    .array(z.enum(SUPPORTED_ALGORITHMS))
    .min(1)
    .max(SUPPORTED_ALGORITHMS.length)
    .optional()
    .default(['sha256'])
    .describe('Hash algorithms to compute (default: sha256)'),
});

// Native Zod v4 record schema: constrains keys to algorithms and values to lowercase hex
const ALGO_LENGTHS: Record<(typeof SUPPORTED_ALGORITHMS)[number], number> = {
  sha256: 64, // 256 bits = 64 hex chars
  sha512: 128, // 512 bits = 128 hex chars
  sha1: 40, // 160 bits = 40 hex chars
  md5: 32, // 128 bits = 32 hex chars
};

// z.partialRecord: keys are optional but MUST be from the enum; rejects unknown keys.
// Generates propertyNames.enum in JSON Schema so clients can validate key names client-side.
const HashesSchema = z.partialRecord(
  z.enum(SUPPORTED_ALGORITHMS),
  z.string().regex(/^[a-f0-9]+$/, { message: 'Must be lowercase hex string' }),
);

const HashOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  filePath: z.string().describe('Resolved file or directory path'),
  algorithms: z
    .array(z.enum(SUPPORTED_ALGORITHMS))
    .min(1)
    .max(SUPPORTED_ALGORITHMS.length)
    .describe('Algorithms computed'),
  hashes: HashesSchema.describe('Algorithm → hex digest mapping'),
  resourceUri: z.string().describe('URI to hashes.json resource'),
  isDirectory: z.boolean().describe('True when hashing a directory'),
  fileCount: NonNegInt.optional().describe('Files hashed (directories only)'),
});

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
  fsOps: GuardedFileSystem,
  filePath: string,
  algorithms: readonly (typeof SUPPORTED_ALGORITHMS)[number][],
  signal?: AbortSignal,
): Promise<Record<string, string>> {
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

  const readStream = await fsOps.createReadStream(filePath, {
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
  const byteLength = Buffer.byteLength(relativePath, 'utf8');
  pathLengthBytes.writeUInt32BE(byteLength, 0);

  hasher.update(pathLengthBytes);
  hasher.update(relativePath, 'utf8');
  hasher.update(fileHash);
}

async function hashDirectory(
  dirPath: string,
  fsOps: GuardedFileSystem,
  pathGuard: PathGuard,
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
    // Skip sensitive files so their content never enters the composite digest.
    // Skipping (rather than aborting) keeps directories that legitimately
    // contain a denylisted file (e.g. `.env`) hashable and deterministic.
    if (pathGuard.isSensitive(entry.path)) {
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
      // Read through the guarded filesystem so each file is re-validated
      // (sensitive denylist + realpath/root containment) before hashing.
      const stream = await fsOps.createReadStream(task.filePath, {
        signal,
        highWaterMark: 64 * 1024,
      });
      const hasher = createHash('sha256');
      await pipeline(stream, hasher, { signal });
      const fileHash = hasher.digest();
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
  fsOps: GuardedFileSystem,
  pathGuard: PathGuard,
  resourceStore: ResourceStore | undefined,
  signal?: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void,
) {
  const { algorithms } = args;

  // Check if path is a directory or file
  const { stats, validPath } = await fsOps.stat(args.path, signal ? { signal } : undefined);

  let hashes: Record<string, string>;
  let fileCount: number | undefined;

  if (stats.isDirectory()) {
    // Directory hashing produces a single SHA-256 composite of the tree.
    // Other algorithms are not supported for directories; reject rather than
    // silently returning a SHA-256 digest mislabeled as the requested algorithm.
    const unsupported = algorithms.filter((algo) => algo !== 'sha256');
    if (unsupported.length > 0) {
      throw new FsError(
        Problem.invalidInput(
          `Directory hashing only supports sha256 (requested: ${unsupported.join(', ')}). ` +
            'Hash individual files to use other algorithms.',
        ),
      );
    }
    const { hash, fileCount: count } = await hashDirectory(validPath, fsOps, pathGuard, {
      ...(signal ? { signal } : {}),
      ...(onProgress ? { onProgress } : {}),
    });
    hashes = { sha256: hash };
    fileCount = count;
  } else {
    // For files, calculate requested algorithms
    hashes = await calculateMultipleHashes(fsOps, validPath, algorithms, signal);
    onProgress?.({ current: 1 });
  }

  // Runtime invariant: native crypto always produces fixed-length digests.
  // If this ever fires, it indicates a logic error in the hash computation path.
  for (const [algo, digest] of Object.entries(hashes)) {
    const expectedLength = ALGO_LENGTHS[algo as (typeof SUPPORTED_ALGORITHMS)[number]];
    if (digest.length !== expectedLength) {
      throw new FsError(
        Problem.invalidInput(
          `Hash computation produced wrong-length ${algo} digest: expected ${String(expectedLength)} hex characters, got ${String(digest.length)}`,
        ),
      );
    }
  }

  // Store hashes as JSON - resourceStore should always be available
  if (!resourceStore) {
    throw new Error('Resource store is required for calculate_hash tool');
  }

  const hashJson = JSON.stringify(hashes, null, 2);
  const { entry, link } = putResource({
    store: resourceStore,
    name: basename(validPath),
    mimeType: 'application/json',
    kind: 'text',
    content: hashJson,
  });

  const fileName = basename(validPath);
  const primaryAlgo = algorithms[0] ?? 'sha256';
  const ALGO_LABELS: Record<string, string> = {
    sha256: 'SHA-256',
    sha1: 'SHA-1',
    sha512: 'SHA-512',
    md5: 'MD5',
  };
  const displayAlgo = ALGO_LABELS[primaryAlgo] ?? primaryAlgo.toUpperCase();
  const primaryHash = hashes[primaryAlgo] ?? Object.values(hashes)[0] ?? '';
  const hashDisplay = primaryHash.length > 16 ? `${primaryHash.slice(0, 16)}\u2026` : primaryHash;
  const summary = `calculate-hash: ${fileName} \u00b7 ${displayAlgo}: ${hashDisplay}`;

  return {
    structured: {
      ok: true as const,
      filePath: validPath,
      // Include all requested algorithms in output for clarity, even though directories only support sha256.
      algorithms: Object.keys(hashes) as (typeof SUPPORTED_ALGORITHMS)[number][],
      hashes,
      resourceUri: entry.uri,
      isDirectory: stats.isDirectory(),
      ...(fileCount !== undefined ? { fileCount } : {}),
    },
    text: summary,
    resources: [link],
  };
}

export const CALCULATE_HASH = defineTool({
  name: 'hash_file',
  title: 'Calculate Hash',
  description: 'Calculate SHA-256, MD5, or other hashes for a file or directory.',
  input: HashInputSchema,
  output: HashOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execution: { taskSupport: 'optional' },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  nuances: [
    'Directory hashing respects root `.gitignore` and sorts paths for stable output.',
    'Hidden files (names starting with `.`) are excluded from directory hashing.',
    'Supported algorithms: sha256, md5, sha1, sha512.',
  ],
  defaultErrorCode: ErrorCode.UNKNOWN,
  progress: (args) => ({
    label: 'Hash',
    subject: basename(args.path),
  }),
  run: async (args, ctx) => {
    const onProgress = ctx.onProgress
      ? ({ current, total }: { total?: number; current: number }): void => {
          ctx.onProgress?.({ current, ...(total !== undefined ? { total } : {}) });
        }
      : undefined;
    return handleCalculateHash(
      args,
      ctx.fs,
      ctx.pathGuard,
      ctx.resourceStore,
      ctx.signal,
      onProgress,
    );
  },
});
export { HashOutputSchema, HashesSchema };
