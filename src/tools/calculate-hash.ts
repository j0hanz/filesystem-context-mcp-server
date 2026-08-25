import type { ContentBlock } from '@modelcontextprotocol/server';

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.js';
import { ErrorCode, FsError, isFsError, rethrowIfAborted } from '../core/errors.js';
import type { GuardedFileSystem } from '../core/fs.js';
import {
  globEntries,
  isIgnoredByGitignore,
  loadRootGitignore,
  resolveEntryType,
} from '../core/glob.js';
import { toPosixRelative } from '../core/path.js';
import type { PathGuard } from '../core/path.js';
import { completablePath, NonNegInt, RequiredPath } from '../core/schema.js';
import { putJsonResource } from '../core/store.js';
import { DEFAULT_SEARCH_TIMEOUT_MS, PARALLEL_CONCURRENCY } from '../core/util.js';
import { defineTool, type ToolCtx } from './define.js';

const SUPPORTED_ALGORITHMS = ['sha256', 'md5', 'sha1', 'sha512'] as const;

const HashInputSchema = z.strictObject({
  path: RequiredPath,
  algorithms: z
    .array(z.enum(SUPPORTED_ALGORITHMS))
    .min(1)
    .max(SUPPORTED_ALGORITHMS.length)
    .refine((arr) => new Set(arr).size === arr.length, {
      message: 'Duplicate algorithms are not allowed',
    })
    .optional()
    .default(['sha256'])
    .describe(
      'Hash algorithms to compute (default: [sha256]); specify multiple to compute several hashes in one call',
    ),
});

// z.partialRecord: keys are optional but MUST be from the enum; rejects unknown keys.
// Generates propertyNames.enum in JSON Schema so clients can validate key names client-side.
const HashesSchema = z.partialRecord(
  z.enum(SUPPORTED_ALGORITHMS),
  z.string().regex(/^[a-f0-9]+$/, { message: 'Must be lowercase hex string' }),
);

const HashOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Always true; call succeeded'),
  filePath: z.string().describe('Resolved absolute path of the hashed file or directory'),
  algorithms: z
    .array(z.enum(SUPPORTED_ALGORITHMS))
    .min(1)
    .max(SUPPORTED_ALGORITHMS.length)
    .describe('List of algorithms that were computed'),
  hashes: HashesSchema.describe(
    'Map of algorithm name to lowercase hex digest (e.g. { sha256: "abc123..." })',
  ),
  resourceUri: z
    .string()
    .optional()
    .describe(
      'URI to the hashes.json resource in the resource store (present when resource store is available)',
    ),
  isDirectory: z
    .boolean()
    .describe('True when the target was a directory (hashes represent all files within)'),
  fileCount: NonNegInt.optional().describe('Number of files hashed (present for directories only)'),
});

const ALGO_LABELS: Record<string, string> = {
  sha256: 'SHA-256',
  sha1: 'SHA-1',
  sha512: 'SHA-512',
  md5: 'MD5',
};

async function calculateMultipleHashes(
  fsOps: GuardedFileSystem,
  filePath: string,
  algorithms: readonly (typeof SUPPORTED_ALGORITHMS)[number][],
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const hashers = new Map<(typeof SUPPORTED_ALGORITHMS)[number], ReturnType<typeof createHash>>();
  for (const algo of algorithms) {
    hashers.set(algo, createHash(algo));
  }

  const splitter = new PassThrough();
  // Each hasher + pipeline adds multiple listeners for internal events
  splitter.setMaxListeners(algorithms.length * 3 + 10);

  // Create pipeline that feeds the file into all hashers
  const hashPromises = Array.from(hashers.values()).map((hasher) =>
    pipeline(splitter, hasher, { signal }),
  );

  const readStream = await fsOps.createReadStream(filePath, {
    signal,
    highWaterMark: 64 * 1024,
  });

  // Feed file data to splitter, which feeds it to all hashers
  await pipeline(readStream, splitter, { signal });

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
    onlyFiles: true,
    suppressErrors: true,
  })) {
    signal?.throwIfAborted();
    if (gitignoreMatcher && isIgnoredByGitignore(gitignoreMatcher, dirPath, entry.path)) {
      continue;
    }
    // Skip sensitive files (including a symlink whose target is sensitive) so
    // their content never enters the composite digest. isEntryAccessible
    // resolves the realpath via validateExistingPathDetailed and checks BOTH
    // the requested and resolved paths — the lexical isSensitive check above
    // missed a symlink → .env, which then threw in Phase 2 and aborted the
    // whole hash. Mirrors list.ts:119. A genuine out-of-root escape rethrows
    // here and aborts, matching the existing "one unreadable file aborts"
    // contract.
    const entryType = resolveEntryType(entry.dirent);
    if (!(await pathGuard.isEntryAccessible(entry.path, entryType, [dirPath]))) {
      continue;
    }
    filteredPaths.push({
      filePath: entry.path,
      relativePath: toPosixRelative(dirPath, entry.path),
    });
  }

  signal?.throwIfAborted();

  const concurrency = Math.min(PARALLEL_CONCURRENCY, 8);
  const totalFiles = filteredPaths.length;
  let filesHashed = 0;
  const { results, errors } = await processInParallel<
    { filePath: string; relativePath: string },
    { path: string; hash: Buffer }
  >(
    filteredPaths,
    async (task) => {
      signal?.throwIfAborted();
      // Read through the guarded filesystem so each file is re-validated
      // (sensitive denylist + realpath/root containment) before hashing.
      const stream = await fsOps.createReadStream(task.filePath, {
        signal,
        highWaterMark: 64 * 1024,
      });
      const hasher = createHash('sha256');
      await pipeline(stream, hasher, { signal });
      filesHashed++;
      onProgress?.({ current: filesHashed, total: totalFiles });
      return { path: task.relativePath, hash: hasher.digest() };
    },
    concurrency,
    signal,
  );
  // One unreadable file aborts the whole directory hash rather than being
  // dropped: a silently skipped file changes the digest and would break
  // sensitive-exclusion determinism. Report the lowest-index failure so the
  // path is stable across runs regardless of completion order.
  if (errors.length > 0) {
    const first = errors.reduce((prev, curr) => (curr.index < prev.index ? curr : prev));
    // Cancellation is not a per-file failure — propagate it unwrapped so the
    // caller still sees an AbortError.
    rethrowIfAborted(first.error);
    const failedPath = filteredPaths[first.index]?.relativePath ?? dirPath;
    const alsoFailed = errors.length > 1 ? ` (and ${errors.length - 1} more)` : '';
    throw new FsError(
      isFsError(first.error) ? first.error.code : ErrorCode.IO_ERROR,
      `Failed to hash ${failedPath}: ${first.error.message}${alsoFailed}`,
      failedPath,
      { failedFiles: errors.length },
      first.error,
    );
  }
  onProgress?.({ current: filesHashed, total: totalFiles });
  signal?.throwIfAborted();
  const entries = results.map((r) => r.value);
  // Sort by path with byte-wise semantics for deterministic ordering.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Create composite hash using length-delimited paths and binary digests.
  const compositeHasher = createHash('sha256');
  const pathLengthBytes = Buffer.allocUnsafe(4);
  for (const { path: filePath, hash: fileHash } of entries) {
    updateCompositeHash(compositeHasher, pathLengthBytes, filePath, fileHash);
    signal?.throwIfAborted();
  }

  return {
    hash: compositeHasher.digest('hex'),
    fileCount: entries.length,
  };
}

async function handleCalculateHash(
  args: z.infer<typeof HashInputSchema>,
  ctx: ToolCtx,
): Promise<{
  structured: z.infer<typeof HashOutputSchema>;
  text: string;
  resources?: ContentBlock[];
}> {
  const { algorithms } = args;

  // Check if path is a directory or file
  const { stats, validPath } = await ctx.fs.stat(args.path, { signal: ctx.signal });

  let hashes: Record<string, string>;
  let fileCount: number | undefined;

  if (stats.isDirectory()) {
    // Directory hashing produces a single SHA-256 composite of the tree.
    // Other algorithms are not supported for directories; reject rather than
    // silently returning a SHA-256 digest mislabeled as the requested algorithm.
    const unsupported = algorithms.filter((algo) => algo !== 'sha256');
    if (unsupported.length > 0) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        `Directory hashing only supports sha256 (requested: ${unsupported.join(', ')}). ` +
          'Hash individual files to use other algorithms.',
      );
    }
    const { hash, fileCount: count } = await hashDirectory(validPath, ctx.fs, ctx.fs.pathGuard, {
      signal: ctx.signal,
      ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
    });
    hashes = { sha256: hash };
    fileCount = count;
  } else {
    // For files, calculate requested algorithms
    hashes = await calculateMultipleHashes(ctx.fs, validPath, algorithms, ctx.signal);
    ctx.onProgress?.({ current: 1, total: 1 });
  }

  const summary = Object.entries(hashes)
    .map(([algo, hash]) => `${ALGO_LABELS[algo] ?? algo.toUpperCase()}: ${hash}`)
    .join('\n');

  let resourceUri: string | undefined;
  let link: ReturnType<typeof putJsonResource>['link'] | undefined;
  if (ctx.resourceStore) {
    const result = putJsonResource(ctx.resourceStore, basename(validPath), hashes);
    resourceUri = result.entry.uri;
    link = result.link;
  }

  return {
    structured: {
      ok: true as const,
      filePath: validPath,
      // Include all requested algorithms in output for clarity, even though directories only support sha256.
      algorithms: Object.keys(hashes) as (typeof SUPPORTED_ALGORITHMS)[number][],
      hashes,
      ...(resourceUri !== undefined ? { resourceUri } : {}),
      isDirectory: stats.isDirectory(),
      ...(fileCount !== undefined ? { fileCount } : {}),
    },
    text: summary,
    ...(link !== undefined ? { resources: [link] } : {}),
  };
}

export const CALCULATE_HASH = defineTool({
  name: 'hash_file',
  title: 'Calculate Hash',
  description:
    'Compute cryptographic hashes for a file or all files within a directory. ' +
    'Supported algorithms: sha256 (default), sha1, sha512, md5. ' +
    'Pass multiple algorithms in one call to get all digests at once.',
  input: HashInputSchema,
  buildInput: (guard) =>
    HashInputSchema.extend({
      path: completablePath(guard, 'path', 'Path of the file or directory to hash'),
    }),
  output: HashOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.UNKNOWN,
  progress: (args) => ({
    label: 'Hash',
    subject: basename(args.path),
  }),
  accessPaths: (args) => [args.path],
  run: (args, ctx) => handleCalculateHash(args, ctx),
});
export { HashOutputSchema, HashesSchema };
