import { AsyncResource } from 'node:async_hooks';
import { type FileHandle, open } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { debuglog } from 'node:util';
import { parentPort, threadId, Worker, workerData } from 'node:worker_threads';

import RE2 from 're2';
import { z } from 'zod/v4';

import type { ContentMatch, SearchContentResult } from '../config.js';
import { assertNotAborted, withAbort, withTimedAbortSignal } from '../core/concurrency.js';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  isTimeoutLikeError,
  McpError,
} from '../core/errors.js';
import { buildGlobOptions, globEntries, isProbablyBinary, stat } from '../core/fs.js';
import type { GlobEntry } from '../core/fs.js';
import { startPerfMeasure } from '../core/observability.js';
import { isPathWithinDirectories, normalizePath } from '../core/path.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_SEARCH_CONTENT_RESULTS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_LINE_CONTENT_LENGTH,
  MAX_SEARCH_DEPTH,
  MAX_SEARCH_RESULTS,
  MAX_SEARCHABLE_FILE_SIZE,
  mergeOptions,
  omitOptionKeys,
  parseEnvInt,
  SEARCH_WORKERS,
} from '../core/util.js';
import {
  CursorSchema,
  defaultFalseBoolean,
  includeHiddenField,
  includeIgnoredField,
  NextCursorSchema,
  NonNegInt,
  OptionalPath,
  PositiveInt,
  SafeGlobPattern,
} from '../schema.js';
import {
  decodeOffsetCursor,
  encodeOffsetCursor,
  formatCount,
  putResource,
  truncateProgressPattern,
} from './_helpers.js';
import { defineTool } from './define.js';

// ---------------------------------------------------------------------------
// Private searchContent implementation (inlined from lib/file-operations/search.ts)
// ---------------------------------------------------------------------------

// --- Matcher helpers ---

interface MatcherOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  isLiteral: boolean;
  fuzzy?: boolean;
}

type Matcher = (line: string) => number;

interface RegexLikeMatcher {
  lastIndex: number;
  exec(input: string): unknown;
}

function countRegexLineMatches(regex: RegexLikeMatcher, line: string): number {
  regex.lastIndex = 0;
  let count = 0;
  while (regex.exec(line) !== null) {
    count++;
    if (regex.lastIndex === 0) regex.lastIndex++;
  }
  return count;
}

function escapeLiteral(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegexPattern(pattern: string, options: MatcherOptions): string {
  const escaped = options.isLiteral ? escapeLiteral(pattern) : pattern;
  return options.wholeWord ? `\\b${escaped}\\b` : escaped;
}

function buildLiteralMatcher(pattern: string, options: MatcherOptions): Matcher {
  if (!options.caseSensitive) {
    const final = escapeLiteral(pattern);
    const regex = new RE2(final, 'gi');
    return (line: string): number => countRegexLineMatches(regex, line);
  }
  const needle = pattern;
  if (needle.length === 0) return () => 0;
  return (line: string): number => {
    if (line.length === 0) return 0;
    let count = 0;
    let pos = line.indexOf(needle);
    while (pos !== -1) {
      count++;
      pos = line.indexOf(needle, pos + needle.length);
    }
    return count;
  };
}

function buildRegexMatcher(final: string, caseSensitive: boolean): Matcher {
  const flags = caseSensitive ? 'g' : 'gi';
  const regex = new RE2(final, flags);
  return (line: string): number => countRegexLineMatches(regex, line);
}

function buildMatcher(pattern: string, options: MatcherOptions): Matcher {
  if (options.fuzzy === true) {
    const threshold = Math.floor(pattern.length / 4);
    const lowerPattern = pattern.toLowerCase();
    return (line: string): number => {
      const words = line.toLowerCase().split(/\s+/);
      return words.some((word) => levenshtein(word, lowerPattern) <= threshold) ? 1 : 0;
    };
  }
  if (options.isLiteral && pattern.length === 0) return () => 0;
  if (options.isLiteral && !options.wholeWord) {
    return buildLiteralMatcher(pattern, options);
  }
  const final = buildRegexPattern(pattern, options);
  return buildRegexMatcher(final, options.caseSensitive);
}

// --- Fuzzy helpers ---

const MAX_FUZZY_FILES = 200;
const MIN_FUZZY_PATTERN_LENGTH = 4;

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = new Array<number>(n + 1);
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] =
        cost === 0
          ? (prev[j - 1] ?? 0)
          : 1 + Math.min(prev[j] ?? 0, curr[j - 1] ?? 0, prev[j - 1] ?? 0);
    }
    prev = curr;
  }
  return prev[n] ?? 0;
}

// --- Configuration & Schemas ---

const SEARCH_CONTENT_MAX_RESULTS = 500;

interface ScanFileOptions {
  maxFileSize: number;
  skipBinary: boolean;
  contextLines: number;
  contextBefore: number;
  contextAfter: number;
}

const SearchOptionsSchema = z.strictObject({
  filePattern: SafeGlobPattern,
  excludePatterns: z.array(z.string()),
  caseSensitive: z.boolean(),
  maxResults: NonNegInt,
  maxFileSize: NonNegInt,
  maxFilesScanned: NonNegInt,
  timeoutMs: NonNegInt,
  skipBinary: z.boolean(),
  contextLines: NonNegInt,
  contextBefore: z.int32().min(0).max(20).optional(),
  contextAfter: z.int32().min(0).max(20).optional(),
  fuzzy: z.boolean().optional(),
  wholeWord: z.boolean(),
  isLiteral: z.boolean(),
  includeHidden: z.boolean(),
  baseNameMatch: z.boolean(),
  caseSensitiveFileMatch: z.boolean(),
  respectGitignore: z.boolean(),
});

type ResolvedOptions = z.infer<typeof SearchOptionsSchema>;

interface SearchContentOptions extends Partial<ResolvedOptions> {
  signal?: AbortSignal;
  onProgress?: (progress: { total?: number; current: number }) => void;
  maxDepth?: number;
}

const SEARCH_CONTENT_DEFAULTS: ResolvedOptions = {
  filePattern: '**/*',
  excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
  caseSensitive: false,
  maxResults: SEARCH_CONTENT_MAX_RESULTS,
  maxFileSize: MAX_SEARCHABLE_FILE_SIZE,
  maxFilesScanned: DEFAULT_SEARCH_MAX_FILES,
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  skipBinary: true,
  contextLines: 0,
  wholeWord: false,
  isLiteral: true,
  includeHidden: false,
  baseNameMatch: true,
  caseSensitiveFileMatch: true,
  respectGitignore: true,
};

const ERROR_SCAN_CANCELLED = 'Scan cancelled';
const ERROR_WORKER_POOL_CLOSED = 'Worker pool closed';
const SEARCH_WORKER_NAME_PREFIX = 'filesystem-search';
const SEARCH_WORKER_RESOURCE_TYPE = 'SearchWorkerTask';

type SearchContentStopReason = NonNullable<SearchContentResult['summary']['stoppedReason']>;

function resolveOptions(options: SearchContentOptions): ResolvedOptions {
  const normalizedOptions = omitOptionKeys(options, ['signal', 'onProgress', 'maxDepth']);
  const merged = mergeOptions(SEARCH_CONTENT_DEFAULTS, normalizedOptions);
  const result = SearchOptionsSchema.safeParse(merged);
  if (!result.success) {
    throw new McpError(
      ErrorCode.INVALID_INPUT,
      `Invalid search options:\n${z.prettifyError(result.error)}`,
      undefined,
      { errors: z.treeifyError(result.error) },
    );
  }
  return result.data;
}

// --- Context Management ---

interface PendingContext {
  buffer: string[];
  remaining: number;
}

class ContextBuffer {
  private readonly beforeCapacity: number;
  private readonly afterCapacity: number;
  private buffer: string[];
  private head = 0;
  private size = 0;
  private pending: PendingContext[] = [];

  constructor(contextBefore: number, contextAfter: number) {
    this.beforeCapacity = Math.max(0, contextBefore);
    this.afterCapacity = Math.max(0, contextAfter);
    this.buffer = new Array<string>(this.beforeCapacity);
  }

  flushPending(line: string): void {
    if (this.pending.length === 0) return;
    let writeIndex = 0;
    for (const p of this.pending) {
      if (p.remaining > 0) {
        p.buffer.push(line);
        p.remaining--;
      }
      if (p.remaining > 0) {
        this.pending[writeIndex] = p;
        writeIndex++;
      }
    }
    this.pending.length = writeIndex;
  }

  updateBefore(line: string): void {
    if (this.beforeCapacity === 0) return;
    this.buffer[this.head] = line;
    this.head = (this.head + 1) % this.beforeCapacity;
    if (this.size < this.beforeCapacity) this.size++;
  }

  add(line: string): void {
    this.flushPending(line);
    this.updateBefore(line);
  }

  snapshotBefore(): string[] {
    if (this.size === 0) return [];
    const result = new Array<string>(this.size);
    if (this.size < this.beforeCapacity) {
      for (let i = 0; i < this.size; i++) {
        result[i] = this.buffer[i] ?? '';
      }
      return result;
    }
    let outIndex = 0;
    for (let i = this.head; i < this.beforeCapacity; i++) {
      result[outIndex] = this.buffer[i] ?? '';
      outIndex++;
    }
    for (let i = 0; i < this.head; i++) {
      result[outIndex] = this.buffer[i] ?? '';
      outIndex++;
    }
    return result;
  }

  scheduleAfter(): string[] {
    if (this.afterCapacity === 0) return [];
    const buffer: string[] = [];
    this.pending.push({ buffer, remaining: this.afterCapacity });
    return buffer;
  }
}

function trimContent(line: string): string {
  return line.length > MAX_LINE_CONTENT_LENGTH
    ? `${line.slice(0, MAX_LINE_CONTENT_LENGTH)}\u2026`
    : line;
}

// --- Scanning ---

interface ScanFileResult {
  readonly matches: readonly ContentMatch[];
  readonly matched: boolean;
  readonly skippedTooLarge: boolean;
  readonly skippedBinary: boolean;
}

function processLineMatch(
  matches: ContentMatch[],
  trimmedLine: string,
  lineNumber: number,
  matchCount: number,
  requestedPath: string,
  ctx?: ContextBuffer,
): void {
  matches.push({
    file: requestedPath,
    line: lineNumber,
    content: trimmedLine,
    matchCount,
    ...(ctx ? { contextBefore: ctx.snapshotBefore(), contextAfter: ctx.scheduleAfter() } : {}),
  });
}

async function readMatches(
  handle: FileHandle,
  requestedPath: string,
  matcher: Matcher,
  options: ScanFileOptions,
  maxMatches: number,
  isCancelled: () => boolean,
  signal?: AbortSignal,
): Promise<ContentMatch[]> {
  if (maxMatches <= 0) return [];

  const matches: ContentMatch[] = [];
  const hasContext = options.contextBefore > 0 || options.contextAfter > 0;
  const ctx = hasContext
    ? new ContextBuffer(options.contextBefore, options.contextAfter)
    : undefined;
  let lineNumber = 1;

  const lines = handle.readLines({ encoding: 'utf-8', signal });
  try {
    for await (const rawLine of lines) {
      if (matches.length >= maxMatches) break;
      if (isCancelled()) break;

      const matchCount = matcher(rawLine);
      let trimmedLine = '';

      if (matchCount > 0) {
        trimmedLine = trimContent(rawLine);
        ctx?.flushPending(trimmedLine);
        processLineMatch(matches, trimmedLine, lineNumber, matchCount, requestedPath, ctx);
        ctx?.updateBefore(trimmedLine);
      } else if (hasContext) {
        trimmedLine = trimContent(rawLine);
        ctx?.add(trimmedLine);
      }
      lineNumber++;
    }
  } finally {
    try {
      lines.close();
    } catch {
      // Ignore close errors
    }
  }

  return matches;
}

type BinaryDetector = (
  resolvedPath: string,
  handle: FileHandle,
  signal?: AbortSignal,
) => Promise<boolean>;

async function scanFileResolved(
  resolvedPath: string,
  requestedPath: string,
  matcher: Matcher,
  options: ScanFileOptions,
  signal?: AbortSignal,
  maxMatches: number = Number.POSITIVE_INFINITY,
  injectedBinaryDetector?: BinaryDetector,
): Promise<ScanFileResult> {
  assertNotAborted(signal);
  await using handle = await withAbort(open(resolvedPath, 'r'), signal);
  const stats = await withAbort(handle.stat(), signal);

  if (stats.size > options.maxFileSize) {
    return {
      matches: [],
      matched: false,
      skippedTooLarge: true,
      skippedBinary: false,
    };
  }

  if (options.skipBinary) {
    const detect = injectedBinaryDetector ?? isProbablyBinary;
    if (await detect(resolvedPath, handle, signal)) {
      return {
        matches: [],
        matched: false,
        skippedTooLarge: false,
        skippedBinary: true,
      };
    }
  }

  const matches = await readMatches(
    handle,
    requestedPath,
    matcher,
    options,
    maxMatches,
    () => Boolean(signal?.aborted),
    signal,
  );

  return {
    matches,
    matched: matches.length > 0,
    skippedTooLarge: false,
    skippedBinary: false,
  };
}

// --- Orchestration ---

interface ResolvedFile {
  resolvedPath: string;
  requestedPath: string;
}

interface ScanSummary {
  filesScanned: number;
  filesMatched: number;
  skippedTooLarge: number;
  skippedBinary: number;
  skippedInaccessible: number;
  truncated: boolean;
  stoppedReason: SearchContentResult['summary']['stoppedReason'];
}

interface ScanOutcome {
  matched: boolean;
  skippedTooLarge: boolean;
  skippedBinary: boolean;
}

function buildScanFileOptions(opts: ResolvedOptions): ScanFileOptions {
  return {
    maxFileSize: opts.maxFileSize,
    skipBinary: opts.skipBinary,
    contextLines: opts.contextLines,
    contextBefore: opts.contextBefore ?? opts.contextLines,
    contextAfter: opts.contextAfter ?? opts.contextLines,
  };
}

function buildMatcherOptions(opts: ResolvedOptions): MatcherOptions {
  return {
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
    isLiteral: opts.isLiteral,
    ...(opts.fuzzy === true ? { fuzzy: true } : {}),
  };
}

function applyScanOutcome(summary: ScanSummary, outcome: ScanOutcome): void {
  if (outcome.matched) summary.filesMatched++;
  if (outcome.skippedBinary) summary.skippedBinary++;
  if (outcome.skippedTooLarge) summary.skippedTooLarge++;
}

function markTruncated(summary: ScanSummary, reason: SearchContentStopReason): void {
  summary.truncated = true;
  summary.stoppedReason = reason;
}

function createScanSummary(): ScanSummary {
  return {
    filesScanned: 0,
    filesMatched: 0,
    skippedTooLarge: 0,
    skippedBinary: 0,
    skippedInaccessible: 0,
    truncated: false,
    stoppedReason: undefined,
  };
}

function buildSearchContentResult(
  root: string,
  pattern: string,
  filePattern: string,
  matches: ContentMatch[],
  summary: ScanSummary,
): SearchContentResult {
  const baseSummary = {
    filesScanned: summary.filesScanned,
    filesMatched: summary.filesMatched,
    matches: matches.length,
    truncated: summary.truncated,
    skippedTooLarge: summary.skippedTooLarge,
    skippedBinary: summary.skippedBinary,
    skippedInaccessible: summary.skippedInaccessible,
  };
  const withReason =
    summary.stoppedReason !== undefined
      ? { ...baseSummary, stoppedReason: summary.stoppedReason }
      : baseSummary;
  return { basePath: root, pattern, filePattern, matches, summary: withReason };
}

interface ScanRequest {
  type: 'scan';
  id: number;
  resolvedPath: string;
  requestedPath: string;
  pattern: string;
  matcherOptions: MatcherOptions;
  scanOptions: ScanFileOptions;
  maxMatches: number;
}

interface ScanResult {
  type: 'result';
  id: number;
  result: {
    matches: readonly ContentMatch[];
    matched: boolean;
    skippedTooLarge: boolean;
    skippedBinary: boolean;
  };
}

interface ScanError {
  type: 'error';
  id: number;
  error: string;
}

type WorkerResponse = ScanResult | ScanError;

type WorkerScanRequest = Omit<ScanRequest, 'type' | 'id'>;
type WorkerScanResult = ScanResult['result'];

interface ScanTask {
  id: number;
  promise: Promise<WorkerScanResult>;
  cancel: () => void;
  racePromise?: Promise<{
    task: ScanTask;
    result: WorkerScanResult | undefined;
    error: Error | undefined;
  }>;
}

const isSourceContext =
  import.meta.url.endsWith('.ts') || process.execArgv.some((a) => a.includes('tsx'));
const WORKER_SCRIPT_URL = new URL(import.meta.url);

class SearchWorkerTaskResource extends AsyncResource {
  #settled = false;

  constructor() {
    super(SEARCH_WORKER_RESOURCE_TYPE);
  }

  resolve(resolver: (result: WorkerScanResult) => void, result: WorkerScanResult): void {
    this.finish(resolver, result);
  }

  reject(rejector: (error: Error) => void, error: Error): void {
    this.finish(rejector, error);
  }

  private finish<TArg>(callback: (value: TArg) => void, value: TArg): void {
    if (this.#settled) return;
    this.#settled = true;
    this.runInAsyncScope(callback, undefined, value);
    this.emitDestroy();
  }
}

interface PendingWorkerRequest {
  resolve: (result: WorkerScanResult) => void;
  reject: (error: Error) => void;
  workerIndex: number;
}

export class SearchWorkerPool {
  private workers: (Worker | undefined)[];
  private pending = new Map<number, PendingWorkerRequest>();
  private nextRequestId = 0;
  private closed = false;
  private size: number;
  private debug: boolean;

  constructor(size: number, debug: boolean) {
    this.size = size;
    this.debug = debug;
    if (size <= 0) throw new Error('Pool size must be positive');
    this.workers = Array.from({ length: size }, (): Worker | undefined => undefined);
  }

  private normalizeWorkerError(error: unknown, fallbackMessage: string): Error {
    if (error instanceof Error) return error;
    return new Error(`${fallbackMessage}: ${formatUnknownErrorMessage(error)}`);
  }

  private rejectPendingForWorker(workerIndex: number, error: Error): void {
    for (const [id, pendingRequest] of this.pending) {
      if (pendingRequest.workerIndex !== workerIndex) continue;
      this.pending.delete(id);
      pendingRequest.reject(error);
    }
  }

  private markWorkerAsUnavailable(workerIndex: number, expectedWorker: Worker): void {
    if (this.closed) return;
    if (this.workers[workerIndex] !== expectedWorker) return;
    this.workers[workerIndex] = undefined;
  }

  private retireWorker(workerIndex: number, expectedWorker: Worker): void {
    this.markWorkerAsUnavailable(workerIndex, expectedWorker);
    void expectedWorker.terminate().catch(() => {
      /* Worker may already be exiting */
    });
  }

  private getWorker(workerIndex: number): Worker {
    const existing = this.workers[workerIndex];
    if (existing) return existing;
    const worker = this.initWorker(workerIndex);
    this.workers[workerIndex] = worker;
    return worker;
  }

  private initWorker(index: number): Worker {
    const worker = new Worker(WORKER_SCRIPT_URL, {
      name: `${SEARCH_WORKER_NAME_PREFIX}-${String(index)}`,
      workerData: { debug: this.debug },
      execArgv: isSourceContext ? ['--import', 'tsx/esm'] : undefined,
    });

    worker.on('message', (msg: WorkerResponse) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.type === 'result') p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    });

    worker.on('messageerror', (error: unknown) => {
      const normalized = this.normalizeWorkerError(
        error,
        `Worker ${String(index)} failed to deserialize a message`,
      );
      this.rejectPendingForWorker(index, normalized);
      this.retireWorker(index, worker);
    });

    worker.on('error', (error: Error) => {
      this.rejectPendingForWorker(index, error);
      this.retireWorker(index, worker);
    });

    worker.on('exit', (exitCode: number) => {
      if (this.closed) return;
      this.rejectPendingForWorker(
        index,
        new Error(`Worker ${String(index)} exited with code ${String(exitCode)}`),
      );
      this.markWorkerAsUnavailable(index, worker);
    });
    worker.unref();
    return worker;
  }

  private getLeastBusyWorkerIndex(): number {
    let workerIndex = 0;
    const workerPendingCounts = new Array<number>(this.size).fill(0);
    for (const p of this.pending.values()) {
      const idx = p.workerIndex;
      workerPendingCounts[idx] = (workerPendingCounts[idx] ?? 0) + 1;
    }

    let minPending = workerPendingCounts[0] ?? 0;
    for (let i = 1; i < this.size; i++) {
      const pendingCount = workerPendingCounts[i] ?? 0;
      if (pendingCount < minPending) {
        minPending = pendingCount;
        workerIndex = i;
      }
    }
    return workerIndex;
  }

  private createWorkerScanPromise(
    id: number,
    worker: Worker,
    workerIndex: number,
    req: WorkerScanRequest,
  ): Promise<WorkerScanResult> {
    return new Promise<WorkerScanResult>((resolve, reject) => {
      const resource = new SearchWorkerTaskResource();
      const pendingRequest: PendingWorkerRequest = {
        resolve: (result) => {
          resource.resolve(resolve, result);
        },
        reject: (error) => {
          resource.reject(reject, error);
        },
        workerIndex,
      };

      this.pending.set(id, pendingRequest);

      try {
        worker.postMessage({ type: 'scan', id, ...req });
      } catch (error: unknown) {
        this.pending.delete(id);
        pendingRequest.reject(
          this.normalizeWorkerError(
            error,
            `Failed to post scan request ${String(id)} to worker ${String(workerIndex)}`,
          ),
        );
        this.retireWorker(workerIndex, worker);
      }
    });
  }

  private cancelPendingScan(id: number, worker: Worker): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    try {
      worker.postMessage({ type: 'cancel', id });
    } catch {
      /* Worker may be terminating */
    }
    entry.reject(new Error(ERROR_SCAN_CANCELLED));
  }

  scan(req: WorkerScanRequest): ScanTask {
    if (this.closed) throw new Error(ERROR_WORKER_POOL_CLOSED);

    const id = this.nextRequestId++;
    const workerIndex = this.getLeastBusyWorkerIndex();

    const worker = this.getWorker(workerIndex);

    const promise = this.createWorkerScanPromise(id, worker, workerIndex, req);

    return {
      id,
      promise,
      cancel: () => {
        this.cancelPendingScan(id, worker);
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error(ERROR_WORKER_POOL_CLOSED));
    this.pending.clear();
    const terminations: Promise<number>[] = [];
    for (let index = 0; index < this.workers.length; index += 1) {
      const worker = this.workers[index];
      if (!worker) continue;
      terminations.push(worker.terminate());
      this.workers[index] = undefined;
    }
    await Promise.all(terminations);
  }
}

function shouldUseWorkers(): boolean {
  return !isSourceContext && SEARCH_WORKERS >= 2;
}

let poolInstance: SearchWorkerPool | null = null;

function getPool(): SearchWorkerPool {
  if (!poolInstance) {
    const debug = process.env['FS_CONTEXT_SEARCH_WORKERS_DEBUG'] === '1';
    poolInstance = new SearchWorkerPool(SEARCH_WORKERS, debug);
  }
  return poolInstance;
}

// --- Execution Strategies ---

async function executeSequential(
  files: AsyncIterable<ResolvedFile>,
  pattern: string,
  opts: ResolvedOptions,
  signal: AbortSignal,
  summary: ScanSummary,
  pathGuard: PathGuard,
): Promise<ContentMatch[]> {
  const matches: ContentMatch[] = [];
  const matcher = buildMatcher(pattern, buildMatcherOptions(opts));
  const scanOpts = buildScanFileOptions(opts);

  for await (const file of files) {
    if (signal.aborted) {
      markTruncated(summary, 'timeout');
      break;
    }
    if (matches.length >= opts.maxResults) {
      markTruncated(summary, 'maxResults');
      break;
    }

    try {
      pathGuard.assertAllowedFileAccess(file.requestedPath);
      const remaining = Math.max(0, opts.maxResults - matches.length);
      const result = await scanFileResolved(
        file.resolvedPath,
        file.requestedPath,
        matcher,
        scanOpts,
        signal,
        remaining,
      );
      applyScanOutcome(summary, result);
      matches.push(...result.matches);
    } catch {
      summary.skippedInaccessible++;
    }
  }
  return matches;
}

interface FillWorkerPoolContext {
  pool: SearchWorkerPool;
  pending: Set<ScanTask>;
  iterator: AsyncIterator<ResolvedFile>;
  pattern: string;
  matcherOpts: MatcherOptions;
  scanOpts: ScanFileOptions;
  maxResults: number;
  currentMatches: number;
  summary: ScanSummary;
}

async function fillWorkerPool(context: FillWorkerPoolContext): Promise<boolean> {
  const {
    pool,
    pending,
    iterator,
    pattern,
    matcherOpts,
    scanOpts,
    maxResults,
    currentMatches,
    summary,
  } = context;

  while (pending.size < SEARCH_WORKERS) {
    const result = await iterator.next();
    if (result.done) return true;

    try {
      const remaining = Math.max(1, maxResults - currentMatches);
      const task = pool.scan({
        resolvedPath: result.value.resolvedPath,
        requestedPath: result.value.requestedPath,
        pattern,
        matcherOptions: matcherOpts,
        scanOptions: scanOpts,
        maxMatches: remaining,
      });
      pending.add(task);
    } catch {
      summary.skippedInaccessible++;
    }
  }
  return false;
}

function processScanResult(
  winner: { result: WorkerScanResult | undefined; error: Error | undefined },
  summary: ScanSummary,
  matches: ContentMatch[],
  maxResults: number,
): void {
  if (winner.error) {
    if (winner.error.message !== ERROR_SCAN_CANCELLED) summary.skippedInaccessible++;
    return;
  }
  if (winner.result) {
    const res = winner.result;
    applyScanOutcome(summary, res);
    const remaining = Math.max(0, maxResults - matches.length);
    if (remaining > 0 && res.matches.length > 0) {
      const take = Math.min(remaining, res.matches.length);
      for (let index = 0; index < take; index += 1) {
        const match = res.matches[index];
        if (match) matches.push(match);
      }
    }
  }
}

async function waitForWinner(pending: Set<ScanTask>): Promise<{
  task: ScanTask;
  result: WorkerScanResult | undefined;
  error: Error | undefined;
}> {
  const raceCandidates: Promise<{
    task: ScanTask;
    result: WorkerScanResult | undefined;
    error: Error | undefined;
  }>[] = [];
  for (const task of pending) {
    task.racePromise ??= task.promise.then(
      (result) => ({ task, result, error: undefined }),
      (err: unknown) => ({
        task,
        result: undefined,
        error: err instanceof Error ? err : new Error(formatUnknownErrorMessage(err)),
      }),
    );
    raceCandidates.push(task.racePromise);
  }
  return Promise.race(raceCandidates);
}

async function executeParallel(
  files: AsyncIterable<ResolvedFile>,
  pattern: string,
  opts: ResolvedOptions,
  signal: AbortSignal,
  summary: ScanSummary,
): Promise<ContentMatch[]> {
  const pool = getPool();
  const matches: ContentMatch[] = [];
  const scanOpts = buildScanFileOptions(opts);
  const matcherOpts = buildMatcherOptions(opts);
  const pending = new Set<ScanTask>();
  const iterator = files[Symbol.asyncIterator]();
  let exhausted = false;

  const onAbort = (): void => {
    markTruncated(summary, 'timeout');
    for (const t of pending) t.cancel();
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      if (signal.aborted || matches.length >= opts.maxResults) break;

      if (!exhausted) {
        exhausted = await fillWorkerPool({
          pool,
          pending,
          iterator,
          pattern,
          matcherOpts,
          scanOpts,
          maxResults: opts.maxResults,
          currentMatches: matches.length,
          summary,
        });
      }

      if (pending.size === 0 && exhausted) break;

      const winner = await waitForWinner(pending);
      pending.delete(winner.task);
      processScanResult(winner, summary, matches, opts.maxResults);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    for (const t of pending) t.cancel();
    if (iterator.return) await iterator.return();
  }

  if (signal.aborted) markTruncated(summary, 'timeout');
  else if (matches.length >= opts.maxResults) markTruncated(summary, 'maxResults');

  return matches;
}

// --- Entry Points ---

async function searchSingleFile(
  details: { resolvedPath: string; requestedPath: string },
  opts: ResolvedOptions,
  pattern: string,
  signal: AbortSignal,
): Promise<SearchContentResult> {
  const summary = createScanSummary();
  summary.filesScanned = 1;
  const matcher = buildMatcher(pattern, buildMatcherOptions(opts));
  const result = await scanFileResolved(
    details.resolvedPath,
    details.requestedPath,
    matcher,
    buildScanFileOptions(opts),
    signal,
    opts.maxResults,
  );
  if (result.matched) summary.filesMatched = 1;
  return buildSearchContentResult(
    dirname(details.resolvedPath),
    pattern,
    opts.filePattern,
    result.matches as ContentMatch[],
    summary,
  );
}

function getValidatedFilePath(
  entry: GlobEntry,
  pathGuard: PathGuard,
  rootDirectories: readonly string[],
): string | null {
  if (!entry.dirent.isFile()) return null;
  const normalized = normalizePath(entry.path);
  if (!isPathWithinDirectories(normalized, rootDirectories)) return null;
  if (pathGuard.isSensitive(entry.path)) return null;
  return normalized;
}

async function searchDirectory(
  details: { resolvedPath: string; requestedPath: string },
  opts: ResolvedOptions,
  pattern: string,
  signal: AbortSignal,
  pathGuard: PathGuard,
  onProgress?: (progress: { total?: number; current: number }) => void,
  maxDepth?: number,
): Promise<SearchContentResult> {
  const root = await pathGuard.validateExistingDirectory(details.resolvedPath);
  const rootDirectories = [root];

  const stream = globEntries(
    buildGlobOptions({
      cwd: root,
      pattern: opts.filePattern,
      excludePatterns: opts.excludePatterns,
      includeHidden: opts.includeHidden,
      baseNameMatch: opts.baseNameMatch,
      caseSensitiveMatch: opts.caseSensitiveFileMatch,
      followSymbolicLinks: false,
      onlyFiles: true,
      stats: false,
      suppressErrors: true,
      respectGitignore: opts.respectGitignore,
      ...(maxDepth !== undefined ? { maxDepth } : {}),
    }),
  );

  const summary = createScanSummary();

  async function* fileGenerator(): AsyncGenerator<ResolvedFile> {
    for await (const entry of stream) {
      if (signal.aborted || summary.filesScanned >= opts.maxFilesScanned) break;

      const normalized = getValidatedFilePath(entry, pathGuard, rootDirectories);
      if (!normalized) continue;

      summary.filesScanned++;
      if (opts.fuzzy === true && summary.filesScanned > MAX_FUZZY_FILES) {
        throw new McpError(
          ErrorCode.INVALID_INPUT,
          `Fuzzy search is limited to ${MAX_FUZZY_FILES} files. Narrow your path or disable fuzzy mode.`,
        );
      }

      if (onProgress) {
        onProgress({ current: summary.filesScanned, total: opts.maxFilesScanned });
      }

      yield { resolvedPath: normalized, requestedPath: entry.path };
    }

    if (summary.filesScanned >= opts.maxFilesScanned) {
      summary.truncated = true;
      summary.stoppedReason = 'maxFiles';
    }

    if (onProgress) {
      onProgress({ current: summary.filesScanned, total: opts.maxFilesScanned });
    }
  }

  const matches = shouldUseWorkers()
    ? await executeParallel(fileGenerator(), pattern, opts, signal, summary)
    : await executeSequential(fileGenerator(), pattern, opts, signal, summary, pathGuard);

  return buildSearchContentResult(root, pattern, opts.filePattern, matches, summary);
}

function buildTimeoutSearchResult(
  basePath: string,
  pattern: string,
  filePattern: string,
): SearchContentResult {
  const timeoutSummary = createScanSummary();
  markTruncated(timeoutSummary, 'timeout');
  return buildSearchContentResult(basePath, pattern, filePattern, [], timeoutSummary);
}

async function searchContent(
  basePath: string,
  pattern: string,
  options: SearchContentOptions = {},
  pathGuard?: PathGuard,
): Promise<SearchContentResult> {
  if (!pathGuard) {
    throw new Error('pathGuard is required in searchContent');
  }
  if (!basePath.trim()) throw new McpError(ErrorCode.INVALID_INPUT, 'basePath required');
  if (typeof pattern !== 'string') throw new McpError(ErrorCode.INVALID_INPUT, 'pattern required');

  const opts = resolveOptions(options);

  if (opts.fuzzy === true) {
    if (!opts.isLiteral) {
      throw new McpError(ErrorCode.INVALID_INPUT, "Cannot use 'fuzzy' with 'isRegex'");
    }
    if (pattern.length < MIN_FUZZY_PATTERN_LENGTH) {
      throw new McpError(
        ErrorCode.INVALID_INPUT,
        `Fuzzy pattern must be at least ${MIN_FUZZY_PATTERN_LENGTH} characters`,
      );
    }
  }

  try {
    return await withTimedAbortSignal(options.signal, opts.timeoutMs, async (signal) => {
      const details = await pathGuard.validateExistingPathDetailed(basePath);
      const { stats: fileStats } = await stat(basePath, pathGuard, { signal });

      if (fileStats.isFile()) {
        return searchSingleFile(details, opts, pattern, signal);
      }

      if (!fileStats.isDirectory()) {
        throw new McpError(ErrorCode.INVALID_INPUT, 'Path must be file or directory', basePath);
      }

      return searchDirectory(
        details,
        opts,
        pattern,
        signal,
        pathGuard,
        options.onProgress,
        options.maxDepth,
      );
    });
  } catch (error: unknown) {
    if (isTimeoutLikeError(error)) {
      return buildTimeoutSearchResult(basePath, pattern, opts.filePattern);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------

/**
 * Configuration constants for the Search Content tool.
 */
const CONFIG = {
  MAX_INLINE_MATCHES: parseEnvInt('FS_CONTEXT_MAX_INLINE_MATCHES', 50, 1, 10_000),
  COMPLETION_LABELS: {
    timeout: 'timeout',
    maxResults: 'max results',
    maxFiles: 'max files',
  } as const,
} as const;

// Type Definitions
type SearchInput = z.infer<typeof GrepInputSchema>;
type SearchOutput = z.infer<typeof GrepOutputSchema>;
type SearchMatchPayload = NonNullable<SearchOutput['matches']>[number];
type SearchResultValue = Awaited<ReturnType<typeof searchContent>>;
type SearchSummary = SearchResultValue['summary'];
type TruthySummaryField =
  | 'filesMatched'
  | 'skippedTooLarge'
  | 'skippedBinary'
  | 'skippedInaccessible';

interface SearchPreviewState {
  needsExternalize: boolean;
  visiblePayloads: SearchMatchPayload[];
  heading: string;
}

interface SearchContext {
  pattern: string;
  matcher?: RE2;
  caseSensitive: boolean;
  foldedPattern?: string;
}

const TRUTHY_SUMMARY_FIELDS: readonly TruthySummaryField[] = [
  'filesMatched',
  'skippedTooLarge',
  'skippedBinary',
  'skippedInaccessible',
];

function buildStructuredSummaryFields(summary: SearchSummary): Partial<SearchOutput> {
  const result: Partial<SearchOutput> = {};
  for (const key of TRUTHY_SUMMARY_FIELDS) {
    const value = summary[key];
    if (value) {
      result[key] = value;
    }
  }
  if (summary.truncated) {
    result.truncated = true;
  }
  if (summary.stoppedReason) {
    result.stoppedReason = summary.stoppedReason;
  }
  return result;
}
function buildSearchPreviewState(payloads: SearchMatchPayload[]): SearchPreviewState {
  const needsExternalize = payloads.length > CONFIG.MAX_INLINE_MATCHES;
  const visibleCount = needsExternalize ? CONFIG.MAX_INLINE_MATCHES : payloads.length;

  return {
    needsExternalize,
    visiblePayloads: payloads.slice(0, visibleCount),
    heading: buildHeading(payloads.length, visibleCount),
  };
}

const GrepInputSchema = z.strictObject({
  path: OptionalPath,
  pattern: SafeGlobPattern.optional().describe('File glob filter (default: all text files)'),
  searchPattern: z
    .string()
    .min(1)
    .max(10000)
    .describe(
      'Text or regex to search for (RE2: no lookahead/lookbehind/backrefs when isRegex=true)',
    )
    .meta({ examples: ['TODO', 'function\\s+(\\w+)', 'import.*from'] }),
  isRegex: defaultFalseBoolean('Treat searchPattern as regex'),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  caseSensitive: defaultFalseBoolean('Case-sensitive'),
  wholeWord: defaultFalseBoolean('Match whole words only'),
  contextLines: z
    .int32()
    .min(0)
    .max(20)
    .optional()
    .describe(
      'Lines of context before AND after each match (symmetric; overridden by contextBefore/contextAfter)',
    ),
  contextBefore: z
    .int32()
    .min(0)
    .max(20)
    .optional()
    .describe('Lines of context before each match (overrides contextLines for before)'),
  contextAfter: z
    .int32()
    .min(0)
    .max(20)
    .optional()
    .describe('Lines of context after each match (overrides contextLines for after)'),
  fuzzy: z
    .boolean()
    .optional()
    .describe(
      'Approximate string matching (Levenshtein-based, \u226425% char difference). Incompatible with isRegex.',
    ),

  maxResults: z
    .uint32()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .default(DEFAULT_SEARCH_CONTENT_RESULTS)
    .describe('Max matches to return per page'),
  maxDepth: z.uint32().min(0).max(MAX_SEARCH_DEPTH).optional().describe('Max directory depth'),
  cursor: CursorSchema,
});

const GrepOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  matches: z
    .array(
      z.strictObject({
        file: z.string().describe('Relative file path'),
        line: PositiveInt.describe('Line number'),
        column: NonNegInt.optional().describe('Column (0-indexed)'),
        content: z.string().describe('Matched line content'),
        matchCount: NonNegInt.optional().describe('Match count on this line'),
        contextBefore: z.array(z.string()).optional().describe('Context lines before'),
        contextAfter: z.array(z.string()).optional().describe('Context lines after'),
      }),
    )
    .describe('Flat list of matches (sorted by file then line)'),
  totalMatches: NonNegInt.optional().describe('Total match count'),
  filesMatched: NonNegInt.optional().describe('Files with matches'),
  filesScanned: NonNegInt.optional().describe('Files scanned'),
  skippedTooLarge: NonNegInt.optional().describe('Files skipped (too large)'),
  skippedBinary: NonNegInt.optional().describe('Files skipped (binary)'),
  skippedInaccessible: NonNegInt.optional().describe('Files skipped (inaccessible)'),
  truncated: z.boolean().optional().describe('Results truncated'),
  stoppedReason: z
    .enum(['maxResults', 'maxFiles', 'timeout'])
    .optional()
    .describe('Why search stopped early'),
  resourceUri: z.string().optional().describe('Full results URI when truncated'),
  nextCursor: NextCursorSchema,
});

function buildHeading(totalMatches: number, visibleMatches: number): string {
  if (visibleMatches >= totalMatches) {
    return `Found ${totalMatches}:`;
  }

  return `Found ${totalMatches} (showing first ${visibleMatches}):`;
}

function buildSearchMatchDetail(totalMatches: number, filesMatched: number): string {
  const matchDetail = formatCount(totalMatches, 'match', 'matches');
  if (filesMatched <= 0) return matchDetail;
  return `${matchDetail} · ${formatCount(filesMatched, 'file', 'files')}`;
}

function buildSearchStructured(
  summary: SearchSummary,
  matches: SearchMatchPayload[],
): SearchOutput {
  return {
    ok: true,
    matches,
    totalMatches: summary.matches,
    filesScanned: summary.filesScanned,
    ...buildStructuredSummaryFields(summary),
  };
}

function buildSortedPayloads(
  result: SearchResultValue,
  context: SearchContext,
): SearchMatchPayload[] {
  const relativeByFile = new Map<string, string>();

  const getRelativeFile = (file: string): string => {
    const cached = relativeByFile.get(file);
    if (cached !== undefined) return cached;

    const rel = relative(result.basePath, file);
    relativeByFile.set(file, rel);
    return rel;
  };

  const payloads = result.matches.map((match, originalIndex) => {
    const relFile = getRelativeFile(match.file);
    const column = findColumnOffset(match.content, context);

    const payload: SearchMatchPayload = {
      file: relFile,
      line: match.line,
      ...(column !== undefined ? { column } : {}),
      content: match.content,
      matchCount: match.matchCount,
      ...(match.contextBefore ? { contextBefore: [...match.contextBefore] } : {}),
      ...(match.contextAfter ? { contextAfter: [...match.contextAfter] } : {}),
    };

    return { payload, originalIndex };
  });

  payloads.sort((left, right) => {
    const fileCompare = left.payload.file.localeCompare(right.payload.file);
    if (fileCompare !== 0) return fileCompare;
    if (left.payload.line !== right.payload.line) return left.payload.line - right.payload.line;
    return left.originalIndex - right.originalIndex;
  });

  return payloads.map((p) => p.payload);
}
function findColumnOffset(content: string, context: SearchContext): number | undefined {
  try {
    if (context.matcher) {
      context.matcher.lastIndex = 0;
      const match = context.matcher.exec(content);
      return match ? match.index : undefined;
    }
    if (context.caseSensitive) {
      const idx = content.indexOf(context.pattern);
      return idx >= 0 ? idx : undefined;
    }
    // Case-insensitive literal search
    const idx = content.toLowerCase().indexOf(context.foldedPattern ?? '');
    return idx >= 0 ? idx : undefined;
  } catch {
    return undefined;
  }
}

function buildSearchContentOptions(
  args: SearchInput,
  signal?: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void,
): SearchContentOptions {
  const options: SearchContentOptions = {
    includeHidden: args.includeHidden,
    excludePatterns: args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS,
    filePattern: args.pattern ?? '**/*',
    caseSensitive: args.caseSensitive,
    wholeWord: args.wholeWord,
    maxResults: args.maxResults,
    isLiteral: !args.isRegex,
    respectGitignore: !args.includeIgnored,
  };

  if (args.contextLines !== undefined) options.contextLines = args.contextLines;
  if (args.contextBefore !== undefined) options.contextBefore = args.contextBefore;
  if (args.contextAfter !== undefined) options.contextAfter = args.contextAfter;
  if (args.fuzzy === true) options.fuzzy = true;
  if (args.maxDepth !== undefined) options.maxDepth = args.maxDepth;
  if (signal) options.signal = signal;
  if (onProgress) options.onProgress = onProgress;

  return options;
}

async function executeSearch(
  args: SearchInput,
  basePath: string,
  pathGuard: PathGuard,
  signal?: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void,
): Promise<SearchResultValue> {
  const options = buildSearchContentOptions(args, signal, onProgress);

  try {
    return await searchContent(basePath, args.searchPattern, options, pathGuard);
  } catch (error) {
    if (error instanceof Error && /regular expression/i.test(error.message)) {
      throw new McpError(
        ErrorCode.INVALID_PATTERN,
        `Invalid regex pattern: ${formatUnknownErrorMessage(error)} (RE2: no lookahead/lookbehind/backrefs)`,
      );
    }
    throw error;
  }
}

function createSearchMatcher(args: SearchInput): RE2 | undefined {
  if (!args.isRegex) return undefined;
  try {
    const flags = args.caseSensitive ? '' : 'i';
    return new RE2(args.searchPattern, flags);
  } catch (error) {
    throw new McpError(
      ErrorCode.INVALID_PATTERN,
      `Invalid regex pattern: ${formatUnknownErrorMessage(error)} (RE2: no lookahead/lookbehind/backrefs)`,
    );
  }
}

function createSearchContext(args: SearchInput, matcher: RE2 | undefined): SearchContext {
  return {
    pattern: args.searchPattern,
    caseSensitive: args.caseSensitive,
    ...(matcher ? { matcher } : {}),
    ...(!args.isRegex && !args.caseSensitive
      ? { foldedPattern: args.searchPattern.toLowerCase() }
      : {}),
  };
}

function buildExternalizedResponse(
  fullStructured: SearchOutput,
  preview: SearchPreviewState,
  resourceStore: ResourceStore,
  searchPattern: string,
): { structured: SearchOutput; link: ReturnType<typeof putResource>['link'] } {
  const resultsJson = JSON.stringify(fullStructured, null, 2);
  const { entry, link } = putResource({
    store: resourceStore,
    name: `'${searchPattern}' matches`,
    mimeType: 'application/json',
    kind: 'text',
    content: resultsJson,
  });

  const structuredForResponse: SearchOutput = {
    ...fullStructured,
    resourceUri: entry.uri,
  };

  if (preview.needsExternalize) {
    structuredForResponse.matches = preview.visiblePayloads;
    structuredForResponse.truncated = true;
  }

  return { structured: structuredForResponse, link };
}

function getPagedPayloads(
  result: SearchResultValue,
  args: SearchInput,
  regexMatcher: RE2 | undefined,
  cursorOffset: number,
): { matchPayloads: SearchMatchPayload[]; nextCursor: string | undefined } {
  const searchContext = createSearchContext(args, regexMatcher);
  const allPayloads = buildSortedPayloads(result, searchContext);
  const matchPayloads = cursorOffset > 0 ? allPayloads.slice(cursorOffset) : allPayloads;

  const nextCursor =
    result.summary.truncated && matchPayloads.length > 0
      ? encodeOffsetCursor(cursorOffset + matchPayloads.length)
      : undefined;

  return { matchPayloads, nextCursor };
}

function finalizeSearchOutput(
  fullStructured: SearchOutput,
  preview: SearchPreviewState,
  matchPayloads: SearchMatchPayload[],
  resourceStore?: ResourceStore,
  searchPattern?: string,
): { structured: SearchOutput; link?: ReturnType<typeof putResource>['link'] } {
  if (resourceStore && matchPayloads.length > 0) {
    return buildExternalizedResponse(fullStructured, preview, resourceStore, searchPattern ?? '');
  }

  if (preview.needsExternalize) {
    fullStructured.matches = preview.visiblePayloads;
    fullStructured.truncated = true;
  }

  return { structured: fullStructured };
}

async function handleSearchContent(
  args: SearchInput,
  pathGuard: PathGuard,
  signal?: AbortSignal,
  resourceStore?: ResourceStore,
  onProgress?: (progress: { total?: number; current: number }) => void,
): Promise<{
  structured: SearchOutput;
  link?: ReturnType<typeof putResource>['link'];
  matchCount: number;
  fileCount: number;
}> {
  const basePath = pathGuard.resolvePathOrRoot(args.path);
  const regexMatcher = createSearchMatcher(args);

  const cursorOffset = args.cursor !== undefined ? decodeOffsetCursor(args.cursor) : 0;
  const pageSize = args.maxResults;
  const fetchMax = cursorOffset + pageSize;

  const result = await executeSearch(
    { ...args, maxResults: fetchMax },
    basePath,
    pathGuard,
    signal,
    onProgress,
  );

  const { matchPayloads, nextCursor } = getPagedPayloads(result, args, regexMatcher, cursorOffset);

  const fullStructured: SearchOutput = {
    ...buildSearchStructured(result.summary, matchPayloads),
  };
  if (nextCursor !== undefined) fullStructured.nextCursor = nextCursor;

  const preview = buildSearchPreviewState(matchPayloads);
  const matchCount = matchPayloads.length;
  const fileCount = new Set(matchPayloads.map((m) => m.file)).size;

  const { structured, link } = finalizeSearchOutput(
    fullStructured,
    preview,
    matchPayloads,
    resourceStore,
    args.searchPattern,
  );

  return {
    structured,
    ...(link !== undefined ? { link } : {}),
    matchCount,
    fileCount,
  };
}

export const SEARCH_CONTENT = defineTool({
  name: 'search_text',
  title: 'Search Content',
  description:
    'Search file contents for text (grep-like). Returns matching lines. ' +
    'Scope with `pattern` (e.g. `**/*.ts`) to reduce noise. ' +
    '`includeHidden=true` for dotfiles.',
  input: GrepInputSchema,
  output: GrepOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execution: { taskSupport: 'optional' },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  nuances: ['Inline results capped at 50 matches; full results via `resourceUri`.'],
  gotchas: [
    'RE2 dialect: no lookahead, lookbehind, or backreferences.',
    'Use `pattern` to scope to specific files; without it, scans every text file.',
    'Skips binary/oversized files silently \u2014 verify with `stat` if no matches.',
    "Patterns without '/' match by filename anywhere in the tree (e.g. *.ts finds all .ts files). Add a path prefix like src/*.ts to restrict to a subtree.",
  ],
  defaultErrorCode: ErrorCode.UNKNOWN,
  progress: (args) => ({
    label: 'Search',
    subject: truncateProgressPattern(args.searchPattern),
  }),
  progressDone: (_args, result) => ({
    detail: buildSearchMatchDetail(result.totalMatches ?? 0, result.filesMatched ?? 0),
  }),
  run: async (args, ctx) => {
    const onProgress = (params: { current: number; total?: number }): void => {
      ctx.onProgress?.({
        current: params.current,
        ...(params.total !== undefined ? { total: params.total } : {}),
      });
    };
    const { structured, link, matchCount, fileCount } = await handleSearchContent(
      args,
      ctx.pathGuard,
      ctx.signal,
      ctx.resourceStore,
      onProgress,
    );
    const summary =
      `search-content: '${args.searchPattern}'` +
      ` \u00b7 ${formatCount(matchCount, 'match', 'matches')}` +
      ` in ${formatCount(fileCount, 'file', 'files')}`;
    if (link) {
      return { structured, text: summary, resources: [link] };
    }
    return { structured, text: summary };
  },
});

// ---------------------------------------------------------------------------
// Worker thread entry point (this file is also spawned as a worker via WORKER_SCRIPT_URL)
// ---------------------------------------------------------------------------

interface CancelRequest {
  type: 'cancel';
  id: number;
}

interface ShutdownRequest {
  type: 'shutdown';
}

type WorkerRequest = ScanRequest | CancelRequest | ShutdownRequest;

const matcherCache = new Map<string, Matcher>();
const MAX_MATCHER_CACHE_SIZE = 100;

function getMatcherCacheKey(pattern: string, options: MatcherOptions): string {
  const cs = options.caseSensitive ? '1' : '0';
  const ww = options.wholeWord ? '1' : '0';
  const lit = options.isLiteral ? '1' : '0';
  const fz = options.fuzzy ? '1' : '0';
  return `${pattern}|${cs}|${ww}|${lit}|${fz}`;
}

function getCachedMatcher(pattern: string, options: MatcherOptions): Matcher {
  const key = getMatcherCacheKey(pattern, options);
  const cached = matcherCache.get(key);
  if (cached) {
    refreshMatcherCacheEntry(key, cached);
    return cached;
  }
  const matcher = buildMatcher(pattern, options);
  refreshMatcherCacheEntry(key, matcher);
  evictOldestMatcherIfNeeded();
  return matcher;
}

function refreshMatcherCacheEntry(key: string, matcher: Matcher): void {
  matcherCache.delete(key);
  matcherCache.set(key, matcher);
}

function evictOldestMatcherIfNeeded(): void {
  if (matcherCache.size <= MAX_MATCHER_CACHE_SIZE) return;
  const firstKey = matcherCache.keys().next().value;
  if (firstKey !== undefined) {
    matcherCache.delete(firstKey);
  }
}

const cancelledRequests = new Set<number>();
const activeRequests = new Set<number>();
let shuttingDown = false;

function maybeFinishShutdown(): void {
  if (!shuttingDown) return;
  if (activeRequests.size > 0) return;
  parentPort?.close();
}

function consumeCancelled(id: number): boolean {
  if (!cancelledRequests.has(id)) return false;
  cancelledRequests.delete(id);
  return true;
}

function markCancelledIfActive(id: number): void {
  if (activeRequests.has(id)) {
    cancelledRequests.add(id);
  }
}

function buildScanResponse(id: number, result: ScanResult['result']): ScanResult {
  return { type: 'result', id, result };
}

function buildErrorResponse(id: number, error: unknown): ScanError {
  return { type: 'error', id, error: formatUnknownErrorMessage(error) };
}

async function handleScanRequest(request: ScanRequest): Promise<void> {
  const { id, resolvedPath, requestedPath, pattern, matcherOptions, scanOptions, maxMatches } =
    request;

  if (consumeCancelled(id)) return;
  activeRequests.add(id);

  const endMeasure = startPerfMeasure('searchWorker.scan', { maxMatches });
  let ok = false;

  try {
    const matcher = getCachedMatcher(pattern, matcherOptions);

    const result = await scanFileResolved(
      resolvedPath,
      requestedPath,
      matcher,
      scanOptions,
      undefined,
      maxMatches,
      isProbablyBinary,
    );

    if (consumeCancelled(id)) return;
    parentPort?.postMessage(buildScanResponse(id, result));
    ok = true;
  } catch (err) {
    if (consumeCancelled(id)) return;
    parentPort?.postMessage(buildErrorResponse(id, err));
  } finally {
    activeRequests.delete(id);
    cancelledRequests.delete(id);
    endMeasure?.(ok);
    maybeFinishShutdown();
  }
}

function handleMessage(message: WorkerRequest): void {
  switch (message.type) {
    case 'scan':
      if (shuttingDown) return;
      void handleScanRequest(message);
      break;
    case 'cancel':
      markCancelledIfActive(message.id);
      break;
    case 'shutdown':
      shuttingDown = true;
      for (const id of activeRequests) {
        markCancelledIfActive(id);
      }
      maybeFinishShutdown();
      break;
    default: {
      const _exhaustive: never = message;
      throw new Error(`Unhandled message type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

const workerLog = debuglog('search-worker');

if (parentPort) {
  parentPort.on('message', handleMessage);
  const data = workerData as { debug?: boolean } | null;
  if (data?.debug) {
    workerLog(`Started with threadId=${String(threadId)}`);
  }
}
