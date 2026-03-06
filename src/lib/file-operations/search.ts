import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Stats } from 'node:fs';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parentPort, threadId, Worker, workerData } from 'node:worker_threads';

import RE2 from 're2';
import safeRegex from 'safe-regex2';
import { z } from 'zod';

import type {
  ContentMatch,
  SearchContentResult,
  SearchFilesResult,
  SearchResult,
} from '../../config.js';
import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_LINE_CONTENT_LENGTH,
  MAX_SEARCHABLE_FILE_SIZE,
  SEARCH_WORKERS,
} from '../constants.js';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  isTimeoutLikeError,
  McpError,
} from '../errors.js';
import {
  assertNotAborted,
  isProbablyBinary,
  withAbort,
  withTimedAbortSignal,
} from '../fs-helpers.js';
import { startPerfMeasure } from '../observability.js';
import {
  assertAllowedFileAccess,
  isPathWithinDirectories,
  isSensitivePath,
  normalizePath,
  validateExistingDirectory,
  validateExistingPathDetailed,
} from '../paths.js';
import {
  mergeOptions,
  omitOptionKeys,
  reportPeriodicProgress,
} from '../utils.js';
import type { DirentLike, EntryType } from './core.js';
import {
  compareOptionalNumberDesc,
  compareStringValues,
  isEntryAccessibleByType,
  isIgnoredByGitignore,
  loadRootGitignore,
  needsStatsForSort,
  resolveEntryType,
  resolveStopReason,
  stableSortByDerivedString,
  withOptionalStoppedReason,
} from './core.js';
import { buildGlobOptions, globEntries } from './traversal.js';

export const MatcherOptionsSchema = z.strictObject({
  caseSensitive: z.boolean(),
  wholeWord: z.boolean(),
  isLiteral: z.boolean(),
  multiline: z.boolean(),
});
export type MatcherOptions = z.infer<typeof MatcherOptionsSchema>;

export type Matcher = (line: string) => number;

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

export function validatePattern(
  pattern: string,
  options: MatcherOptions
): void {
  if (options.isLiteral && pattern.length === 0) return;
  if (options.isLiteral && !options.wholeWord) return;

  const final = buildRegexPattern(pattern, options);
  if (!safeRegex(final)) {
    throw new Error(
      `Potentially unsafe regular expression (ReDoS risk): ${pattern}`
    );
  }
}

function buildLiteralMatcher(
  pattern: string,
  options: MatcherOptions
): Matcher {
  if (!options.caseSensitive) {
    const final = escapeLiteral(pattern);
    const regex = new RegExp(final, 'gi');
    return (line: string): number => countRegexLineMatches(regex, line);
  }

  // Fast path for case-sensitive literal
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

function buildRegexMatcher(
  final: string,
  caseSensitive: boolean,
  multiline: boolean
): Matcher {
  let flags = caseSensitive ? 'g' : 'gi';
  if (multiline) flags += 'm';
  const regex = new RE2(final, flags);
  return (line: string): number => countRegexLineMatches(regex, line);
}

export function buildMatcher(
  pattern: string,
  options: MatcherOptions
): Matcher {
  if (options.isLiteral && pattern.length === 0) return () => 0;

  if (options.isLiteral && !options.wholeWord) {
    // fast path for simple literal search
    return buildLiteralMatcher(pattern, options);
  }

  const final = buildRegexPattern(pattern, options);
  validatePattern(pattern, options); // Re-validate to be safe
  return buildRegexMatcher(final, options.caseSensitive, options.multiline);
}

// --- Configuration & Schemas ---

const SEARCH_CONTENT_MAX_RESULTS = 500;

export interface ScanFileOptions {
  maxFileSize: number;
  skipBinary: boolean;
  contextLines: number;
}

const SearchOptionsSchema = z.strictObject({
  filePattern: z.string().min(1),
  excludePatterns: z.array(z.string()),
  caseSensitive: z.boolean(),
  maxResults: z.int().min(0),
  maxFileSize: z.int().min(0),
  maxFilesScanned: z.int().min(0),
  timeoutMs: z.int().min(0),
  skipBinary: z.boolean(),
  contextLines: z.int().min(0),
  wholeWord: z.boolean(),
  isLiteral: z.boolean(),
  multiline: z.boolean(),
  includeHidden: z.boolean(),
  baseNameMatch: z.boolean(),
  caseSensitiveFileMatch: z.boolean(),
});

type ResolvedOptions = z.infer<typeof SearchOptionsSchema>;

export interface SearchContentOptions extends Partial<ResolvedOptions> {
  signal?: AbortSignal;
  onProgress?: (progress: { total?: number; current: number }) => void;
}

const DEFAULTS: ResolvedOptions = {
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
  multiline: false,
  includeHidden: false,
  baseNameMatch: false,
  caseSensitiveFileMatch: true,
};

const ERROR_SCAN_CANCELLED = 'Scan cancelled';
const ERROR_WORKER_POOL_CLOSED = 'Worker pool closed';

// --- Helpers ---

function resolveOptions(options: SearchContentOptions): ResolvedOptions {
  const normalizedOptions = omitOptionKeys(options, ['signal', 'onProgress']);
  const merged = mergeOptions(DEFAULTS, normalizedOptions);
  const result = SearchOptionsSchema.safeParse(merged);

  if (!result.success) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      `Invalid search options: ${result.error.message}`,
      undefined,
      { errors: z.treeifyError(result.error) }
    );
  }
  return result.data;
}

// --- Context Management ---

interface PendingContext {
  buffer: string[];
  remaining: number;
}

/**
 * Manages a sliding window of lines and pending context-after buffers.
 */
class ContextBuffer {
  private readonly capacity: number;
  private buffer: string[]; // Ring buffer fixed size
  private head = 0; // Next write index
  private size = 0; // Current count of items
  private pending: PendingContext[] = [];

  constructor(contextLines: number) {
    this.capacity = Math.max(0, contextLines);
    this.buffer = new Array<string>(this.capacity);
  }

  add(line: string): void {
    // 1. Fill Pending 'After' Contexts
    if (this.pending.length > 0) {
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

    // 2. Maintain 'Before' Buffer
    if (this.capacity > 0) {
      this.buffer[this.head] = line;
      this.head = (this.head + 1) % this.capacity;
      if (this.size < this.capacity) {
        this.size++;
      }
    }
  }

  snapshotBefore(): string[] {
    if (this.size === 0) return [];
    const result = new Array<string>(this.size);

    if (this.size < this.capacity) {
      for (let i = 0; i < this.size; i++) {
        result[i] = this.buffer[i] ?? '';
      }
      return result;
    }

    let outIndex = 0;
    for (let i = this.head; i < this.capacity; i++) {
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
    if (this.capacity === 0) return [];
    const buffer: string[] = [];
    this.pending.push({ buffer, remaining: this.capacity });
    return buffer;
  }
}

function trimContent(line: string): string {
  return line.length > MAX_LINE_CONTENT_LENGTH
    ? line.slice(0, MAX_LINE_CONTENT_LENGTH)
    : line;
}

// --- Scanning ---

interface ScanFileResult {
  readonly matches: readonly ContentMatch[];
  readonly matched: boolean;
  readonly skippedTooLarge: boolean;
  readonly skippedBinary: boolean;
}

async function readMatches(
  handle: fsp.FileHandle,
  requestedPath: string,
  matcher: Matcher,
  options: ScanFileOptions,
  maxMatches: number,
  isCancelled: () => boolean,
  signal?: AbortSignal
): Promise<ContentMatch[]> {
  const matches: ContentMatch[] = [];
  const hasContext = options.contextLines > 0;
  const ctx = hasContext ? new ContextBuffer(options.contextLines) : undefined;
  let lineNumber = 1;

  // Use for-await with readLines for memory efficiency
  const lines = handle.readLines({ encoding: 'utf-8', signal });

  try {
    for await (const rawLine of lines) {
      if (matches.length >= maxMatches) break;
      if (isCancelled()) break;

      const matchCount = matcher(rawLine);
      const trimmedLine =
        hasContext || matchCount > 0 ? trimContent(rawLine) : '';

      if (matchCount > 0) {
        if (ctx) {
          matches.push({
            file: requestedPath,
            line: lineNumber,
            content: trimmedLine,
            matchCount,
            contextBefore: ctx.snapshotBefore(),
            contextAfter: ctx.scheduleAfter(),
          });
        } else {
          matches.push({
            file: requestedPath,
            line: lineNumber,
            content: trimmedLine,
            matchCount,
          });
        }
      }

      if (ctx) {
        ctx.add(trimmedLine);
      }
      lineNumber++;
    }
  } finally {
    try {
      lines.close();
    } catch {
      // Ignore close errors; handle cleanup is still managed by the caller.
    }
  }

  return matches;
}

type BinaryDetector = (
  resolvedPath: string,
  handle: fsp.FileHandle,
  signal?: AbortSignal
) => Promise<boolean>;

async function scanFileResolved(
  resolvedPath: string,
  requestedPath: string,
  matcher: Matcher,
  options: ScanFileOptions,
  signal?: AbortSignal,
  maxMatches: number = Number.POSITIVE_INFINITY,
  injectedBinaryDetector?: BinaryDetector
): Promise<ScanFileResult> {
  assertNotAborted(signal);
  const handle = await withAbort(fsp.open(resolvedPath, 'r'), signal);

  try {
    const stats = await withAbort(handle.stat(), signal);

    // 1. Size Check
    if (stats.size > options.maxFileSize) {
      return {
        matches: [],
        matched: false,
        skippedTooLarge: true,
        skippedBinary: false,
      };
    }

    // 2. Binary Check
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

    // 3. Scan Content
    const matches = await readMatches(
      handle,
      requestedPath,
      matcher,
      options,
      maxMatches,
      () => Boolean(signal?.aborted),
      signal
    );

    return {
      matches,
      matched: matches.length > 0,
      skippedTooLarge: false,
      skippedBinary: false,
    };
  } finally {
    await handle.close();
  }
}

// --- Orchestration (Single & Multi-threaded) ---

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
  };
}

function applyScanOutcome(summary: ScanSummary, outcome: ScanOutcome): void {
  if (outcome.matched) summary.filesMatched++;
  if (outcome.skippedBinary) summary.skippedBinary++;
  if (outcome.skippedTooLarge) summary.skippedTooLarge++;
}

function markTruncated(
  summary: ScanSummary,
  reason: NonNullable<SearchContentResult['summary']['stoppedReason']>
): void {
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
  summary: ScanSummary
): SearchContentResult {
  const baseSummary = {
    filesScanned: summary.filesScanned,
    filesMatched: summary.filesMatched,
    matches: matches.length,
    truncated: summary.truncated,
    skippedTooLarge: summary.skippedTooLarge,
    skippedBinary: summary.skippedBinary,
    skippedInaccessible: summary.skippedInaccessible,
    linesSkippedDueToRegexTimeout: 0,
  };

  return {
    basePath: root,
    pattern,
    filePattern,
    matches,
    summary: withOptionalStoppedReason(baseSummary, summary.stoppedReason),
  };
}

export interface ScanRequest {
  type: 'scan';
  id: number;
  resolvedPath: string;
  requestedPath: string;
  pattern: string;
  matcherOptions: MatcherOptions;
  scanOptions: ScanFileOptions;
  maxMatches: number;
}

export interface ScanResult {
  type: 'result';
  id: number;
  result: {
    matches: readonly ContentMatch[];
    matched: boolean;
    skippedTooLarge: boolean;
    skippedBinary: boolean;
  };
}

export interface ScanError {
  type: 'error';
  id: number;
  error: string;
}

export type WorkerResponse = ScanResult | ScanError;

interface WorkerScanRequest {
  resolvedPath: string;
  requestedPath: string;
  pattern: string;
  matcherOptions: MatcherOptions;
  scanOptions: ScanFileOptions;
  maxMatches: number;
}

interface WorkerScanResult {
  matches: readonly ContentMatch[];
  matched: boolean;
  skippedTooLarge: boolean;
  skippedBinary: boolean;
}

interface ScanTask {
  id: number;
  promise: Promise<WorkerScanResult>;
  cancel: () => void;
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const isSourceContext =
  currentDir.endsWith('src\\lib\\file-operations') ||
  currentDir.endsWith('src/lib/file-operations');
const WORKER_SCRIPT_PATH = path.join(
  currentDir,
  isSourceContext ? 'search-worker.ts' : 'search-worker.js'
);
const WORKER_SCRIPT_URL = pathToFileURL(WORKER_SCRIPT_PATH);
const hasWorkerScript = existsSync(WORKER_SCRIPT_PATH);

class SearchWorkerPool {
  private workers: (Worker | undefined)[];
  private pending = new Map<
    number,
    {
      resolve: (val: WorkerScanResult) => void;
      reject: (err: Error) => void;
      workerIndex: number;
    }
  >();
  private nextRequestId = 0;
  private closed = false;
  private workerRoundRobin = 0;

  constructor(
    private size: number,
    private debug: boolean
  ) {
    if (size <= 0) throw new Error('Pool size must be positive');
    this.workers = Array.from(
      { length: size },
      (): Worker | undefined => undefined
    );
  }

  private normalizeWorkerError(error: unknown, fallbackMessage: string): Error {
    if (error instanceof Error) {
      return error;
    }
    return new Error(`${fallbackMessage}: ${formatUnknownErrorMessage(error)}`);
  }

  private rejectPendingForWorker(workerIndex: number, error: Error): void {
    for (const [id, pendingRequest] of this.pending) {
      if (pendingRequest.workerIndex !== workerIndex) {
        continue;
      }
      this.pending.delete(id);
      pendingRequest.reject(error);
    }
  }

  private markWorkerAsUnavailable(
    workerIndex: number,
    expectedWorker: Worker
  ): void {
    if (this.closed) return;
    if (this.workers[workerIndex] !== expectedWorker) return;
    this.workers[workerIndex] = undefined;
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
        `Worker ${String(index)} failed to deserialize a message`
      );
      this.rejectPendingForWorker(index, normalized);
      this.markWorkerAsUnavailable(index, worker);
    });

    worker.on('error', (error: Error) => {
      this.rejectPendingForWorker(index, error);
      this.markWorkerAsUnavailable(index, worker);
    });

    worker.on('exit', (exitCode: number) => {
      if (this.closed) return;
      this.rejectPendingForWorker(
        index,
        new Error(
          `Worker ${String(index)} exited with code ${String(exitCode)}`
        )
      );
      this.markWorkerAsUnavailable(index, worker);
    });
    worker.unref();

    return worker;
  }

  scan(req: WorkerScanRequest): ScanTask {
    if (this.closed) throw new Error(ERROR_WORKER_POOL_CLOSED);

    const id = this.nextRequestId++;
    const workerIndex = this.workerRoundRobin % this.size;
    const worker = this.getWorker(workerIndex);

    this.workerRoundRobin++;

    const promise = new Promise<WorkerScanResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, workerIndex });
      try {
        worker.postMessage({ type: 'scan', id, ...req } as ScanRequest);
      } catch (error: unknown) {
        this.pending.delete(id);
        reject(
          this.normalizeWorkerError(
            error,
            `Failed to post scan request ${String(id)} to worker ${String(
              workerIndex
            )}`
          )
        );
        this.markWorkerAsUnavailable(workerIndex, worker);
      }
    });

    return {
      id,
      promise,
      cancel: () => {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          try {
            worker.postMessage({ type: 'cancel', id });
          } catch {
            // Worker may already be terminating
          }
          entry.reject(new Error(ERROR_SCAN_CANCELLED));
        }
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.pending.values())
      p.reject(new Error(ERROR_WORKER_POOL_CLOSED));
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

function isWorkerPoolAvailable(): boolean {
  return !isSourceContext && hasWorkerScript;
}

function shouldUseWorkers(): boolean {
  return isWorkerPoolAvailable() && SEARCH_WORKERS >= 2;
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
  summary: ScanSummary
): Promise<ContentMatch[]> {
  const matches: ContentMatch[] = [];
  const matcher = buildMatcher(pattern, opts);
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
      assertAllowedFileAccess(file.requestedPath, file.resolvedPath);
      const remaining = opts.maxResults - matches.length;
      const result = await scanFileResolved(
        file.resolvedPath,
        file.requestedPath,
        matcher,
        scanOpts,
        signal,
        remaining
      );

      applyScanOutcome(summary, result);

      matches.push(...result.matches);
    } catch {
      // Ignore access errors during mass scan
      summary.skippedInaccessible++;
    }
  }
  return matches;
}

// Helper to manage pool filling
async function fillWorkerPool(
  pool: SearchWorkerPool,
  pending: Set<ScanTask>,
  iterator: AsyncIterator<ResolvedFile>,
  pattern: string,
  matcherOpts: MatcherOptions,
  scanOpts: ScanFileOptions,
  maxResults: number,
  currentMatches: number,
  summary: ScanSummary
): Promise<boolean> {
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
  maxResults: number
): void {
  if (winner.error) {
    if (winner.error.message !== ERROR_SCAN_CANCELLED) {
      summary.skippedInaccessible++;
    }
    return;
  }

  if (winner.result) {
    const res = winner.result;
    applyScanOutcome(summary, res);

    const remaining = maxResults - matches.length;
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
    raceCandidates.push(
      task.promise.then(
        (result) => ({ task, result, error: undefined }),
        (err: unknown) => ({
          task,
          result: undefined,
          error:
            err instanceof Error
              ? err
              : new Error(formatUnknownErrorMessage(err)),
        })
      )
    );
  }
  return Promise.race(raceCandidates);
}

async function executeParallel(
  files: AsyncIterable<ResolvedFile>,
  pattern: string,
  opts: ResolvedOptions,
  signal: AbortSignal,
  summary: ScanSummary
): Promise<ContentMatch[]> {
  const pool = getPool();
  const matches: ContentMatch[] = [];
  const scanOpts = buildScanFileOptions(opts);
  const matcherOpts: MatcherOptions = {
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
    isLiteral: opts.isLiteral,
    multiline: opts.multiline,
  };

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
      if (signal.aborted || matches.length >= opts.maxResults) {
        break;
      }

      if (!exhausted) {
        exhausted = await fillWorkerPool(
          pool,
          pending,
          iterator,
          pattern,
          matcherOpts,
          scanOpts,
          opts.maxResults,
          matches.length,
          summary
        );
      }

      if (pending.size === 0 && exhausted) {
        break;
      }

      // Wait for at least one
      const winner = await waitForWinner(pending);
      pending.delete(winner.task);

      processScanResult(winner, summary, matches, opts.maxResults);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Cancel remaining
    for (const t of pending) t.cancel();
    if (iterator.return) await iterator.return();
  }

  // Update summary truncation
  if (signal.aborted) {
    markTruncated(summary, 'timeout');
  } else if (matches.length >= opts.maxResults) {
    markTruncated(summary, 'maxResults');
  }

  return matches;
}

// --- Entry Points ---

export async function scanFileInWorker(
  resolvedPath: string,
  requestedPath: string,
  matcher: Matcher,
  options: ScanFileOptions,
  maxMatches: number,
  isCancelled: () => boolean,
  isBinaryDetector: BinaryDetector
): Promise<WorkerScanResult> {
  // Direct scan used by worker script
  const res = await scanFileResolved(
    resolvedPath,
    requestedPath,
    matcher,
    options,
    undefined,
    maxMatches,
    isBinaryDetector
  );
  return {
    matches: res.matches,
    matched: res.matched,
    skippedBinary: res.skippedBinary,
    skippedTooLarge: res.skippedTooLarge,
  };
}

async function searchSingleFile(
  details: { resolvedPath: string; requestedPath: string },
  opts: ResolvedOptions,
  pattern: string,
  signal: AbortSignal
): Promise<SearchContentResult> {
  const summary = createScanSummary();
  summary.filesScanned = 1;

  const matcher = buildMatcher(pattern, opts);
  const result = await scanFileResolved(
    details.resolvedPath,
    details.requestedPath,
    matcher,
    {
      ...buildScanFileOptions(opts),
    },
    signal,
    opts.maxResults
  );

  if (result.matched) summary.filesMatched = 1;

  return buildSearchContentResult(
    path.dirname(details.resolvedPath),
    pattern,
    opts.filePattern,
    result.matches as ContentMatch[],
    summary
  );
}

async function searchDirectory(
  details: { resolvedPath: string; requestedPath: string },
  opts: ResolvedOptions,
  pattern: string,
  signal: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<SearchContentResult> {
  const root = await validateExistingDirectory(details.resolvedPath, signal);
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
    })
  );

  async function* fileGenerator(): AsyncGenerator<ResolvedFile> {
    let scanned = 0;
    for await (const entry of stream) {
      if (signal.aborted) break;
      if (scanned >= opts.maxFilesScanned) break;

      if (!entry.dirent.isFile()) continue;

      const normalized = normalizePath(entry.path);
      if (!isPathWithinDirectories(normalized, rootDirectories)) continue;
      if (isSensitivePath(entry.path, normalized)) continue;

      scanned++;
      reportPeriodicProgress(onProgress, scanned, {
        total: opts.maxFilesScanned,
        throttleModulo: 25,
      });

      yield { resolvedPath: normalized, requestedPath: entry.path };
    }

    reportPeriodicProgress(onProgress, scanned, {
      total: opts.maxFilesScanned,
      throttleModulo: 25,
      force: true,
    });
  }

  const summary = createScanSummary();
  const resolvedStream = fileGenerator();

  async function* countingStream(): AsyncGenerator<ResolvedFile> {
    for await (const f of resolvedStream) {
      summary.filesScanned++;
      yield f;
    }
    if (summary.filesScanned >= opts.maxFilesScanned) {
      summary.truncated = true;
      summary.stoppedReason = 'maxFiles';
    }
  }

  const matcherOpts: MatcherOptions = {
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
    isLiteral: opts.isLiteral,
    multiline: opts.multiline,
  };
  validatePattern(pattern, matcherOpts);

  const matches = shouldUseWorkers()
    ? await executeParallel(countingStream(), pattern, opts, signal, summary)
    : await executeSequential(countingStream(), pattern, opts, signal, summary);

  return buildSearchContentResult(
    root,
    pattern,
    opts.filePattern,
    matches,
    summary
  );
}

function buildTimeoutSearchResult(
  basePath: string,
  pattern: string,
  filePattern: string
): SearchContentResult {
  const timeoutSummary = createScanSummary();
  markTruncated(timeoutSummary, 'timeout');
  return buildSearchContentResult(
    basePath,
    pattern,
    filePattern,
    [],
    timeoutSummary
  );
}

export async function searchContent(
  basePath: string,
  pattern: string,
  options: SearchContentOptions = {}
): Promise<SearchContentResult> {
  if (!basePath.trim())
    throw new McpError(ErrorCode.E_INVALID_INPUT, 'basePath required');
  if (typeof pattern !== 'string')
    throw new McpError(ErrorCode.E_INVALID_INPUT, 'pattern required');

  const opts = resolveOptions(options);
  try {
    return await withTimedAbortSignal(
      options.signal,
      opts.timeoutMs,
      async (signal) => {
        const details = await validateExistingPathDetailed(basePath, signal);
        const stats = await withAbort(fsp.stat(details.resolvedPath), signal);

        if (stats.isFile()) {
          return searchSingleFile(details, opts, pattern, signal);
        }

        if (!stats.isDirectory()) {
          throw new McpError(
            ErrorCode.E_INVALID_INPUT,
            'Path must be file or directory',
            basePath
          );
        }

        return searchDirectory(
          details,
          opts,
          pattern,
          signal,
          options.onProgress
        );
      }
    );
  } catch (error: unknown) {
    if (isTimeoutLikeError(error)) {
      return buildTimeoutSearchResult(basePath, pattern, opts.filePattern);
    }
    throw error;
  }
}

// Internal default for find tool - not exposed to MCP users
const SEARCH_FILES_MAX_RESULTS = 1000;

type SortBy = 'name' | 'size' | 'modified' | 'path';

interface SearchFilesOptions {
  maxResults?: number;
  sortBy?: SortBy;
  maxDepth?: number;
  maxFilesScanned?: number;
  timeoutMs?: number;
  baseNameMatch?: boolean;
  skipSymlinks?: boolean;
  includeHidden?: boolean;
  respectGitignore?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: { total?: number; current: number }) => void;
}

type NormalizedOptions = Required<
  Omit<SearchFilesOptions, 'maxDepth' | 'sortBy' | 'signal' | 'onProgress'>
> & {
  maxDepth?: number;
  sortBy: NonNullable<SearchFilesOptions['sortBy']>;
};

type StopReason = SearchFilesResult['summary']['stoppedReason'];

function normalizeSearchFilesOptions(
  options: SearchFilesOptions
): NormalizedOptions {
  const normalized: NormalizedOptions = {
    maxResults: options.maxResults ?? SEARCH_FILES_MAX_RESULTS,
    sortBy: options.sortBy ?? 'path',
    maxFilesScanned: options.maxFilesScanned ?? DEFAULT_SEARCH_MAX_FILES,
    timeoutMs: options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    baseNameMatch: options.baseNameMatch ?? false,
    skipSymlinks: options.skipSymlinks ?? true,
    includeHidden: options.includeHidden ?? false,
    respectGitignore: options.respectGitignore ?? false,
  };
  if (options.maxDepth !== undefined) {
    normalized.maxDepth = options.maxDepth;
  }
  return normalized;
}

interface SearchEntry {
  path: string;
  relativePath?: string;
  dirent: DirentLike;
  stats?: Stats;
}

interface CollectState {
  results: SearchResult[];
  filesScanned: number;
  truncated: boolean;
  stoppedReason?: StopReason;
  skippedInaccessible: number;
}

interface CollectOutcome {
  results: SearchResult[];
  filesScanned: number;
  truncated: boolean;
  stoppedReason?: StopReason;
  skippedInaccessible: number;
}

function buildSearchFilesResult(
  entry: { path: string; stats?: Stats },
  entryType: EntryType,
  needsStats: boolean
): SearchResult {
  let resolvedType: SearchResult['type'] = 'other';
  if (entryType === 'directory') {
    resolvedType = 'directory';
  } else if (entryType === 'file') {
    resolvedType = 'file';
  }
  const size =
    needsStats && entry.stats?.isFile() ? entry.stats.size : undefined;
  const modified = needsStats ? entry.stats?.mtime : undefined;
  return {
    path: entry.path,
    type: resolvedType,
    ...(size !== undefined ? { size } : {}),
    ...(modified !== undefined ? { modified } : {}),
  };
}

function shouldStopCollecting(
  state: CollectState,
  normalized: NormalizedOptions,
  signal: AbortSignal
): boolean {
  const stopReason = resolveStopReason<Exclude<StopReason, undefined>>({
    signal,
    current: state.filesScanned,
    max: normalized.maxFilesScanned,
    abortedReason: 'timeout',
    maxReason: 'maxFiles',
  });
  if (stopReason !== undefined) {
    state.truncated = true;
    state.stoppedReason = stopReason;
    return true;
  }
  return false;
}

function shouldIncludeEntry(
  entryType: EntryType,
  normalized: NormalizedOptions
): boolean {
  return !normalized.skipSymlinks || entryType !== 'symlink';
}

function createCollectState(): CollectState {
  return {
    results: [],
    filesScanned: 0,
    truncated: false,
    skippedInaccessible: 0,
  };
}

function buildSearchStream(
  root: string,
  pattern: string,
  excludePatterns: readonly string[],
  normalized: NormalizedOptions,
  needsStats: boolean
): AsyncIterable<SearchEntry> {
  const options = buildGlobOptions({
    cwd: root,
    pattern,
    excludePatterns,
    includeHidden: normalized.includeHidden,
    baseNameMatch: normalized.baseNameMatch,
    caseSensitiveMatch: true,
    followSymbolicLinks: false,
    onlyFiles: true,
    stats: needsStats,
    ...(normalized.maxDepth !== undefined
      ? { maxDepth: normalized.maxDepth }
      : {}),
  });
  return globEntries(options);
}

function buildCollectResult(state: CollectState): CollectOutcome {
  const outcome: CollectOutcome = {
    results: state.results,
    filesScanned: state.filesScanned,
    truncated: state.truncated,
    skippedInaccessible: state.skippedInaccessible,
  };

  if (state.stoppedReason !== undefined) {
    outcome.stoppedReason = state.stoppedReason;
  }

  return outcome;
}

function handleEntry(
  entry: SearchEntry,
  entryType: EntryType,
  needsStats: boolean,
  normalized: NormalizedOptions,
  state: CollectState
): void {
  state.results.push(buildSearchFilesResult(entry, entryType, needsStats));
  if (state.results.length >= normalized.maxResults) {
    state.truncated = true;
    state.stoppedReason = 'maxResults';
  }
}

async function collectFromStream(
  stream: AsyncIterable<SearchEntry>,
  root: string,
  rootDirectories: readonly string[],
  gitignoreMatcher: Awaited<ReturnType<typeof loadRootGitignore>>,
  normalized: NormalizedOptions,
  needsStats: boolean,
  state: CollectState,
  signal: AbortSignal,
  accessDeps: Parameters<typeof isEntryAccessibleByType>[4],
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<void> {
  for await (const entry of stream) {
    if (shouldStopCollecting(state, normalized, signal)) break;
    state.filesScanned++;
    reportPeriodicProgress(onProgress, state.filesScanned, {
      total: normalized.maxFilesScanned,
      throttleModulo: 25,
    });

    if (
      isEntryIgnoredByGitignore(
        gitignoreMatcher,
        root,
        entry.path,
        entry.relativePath
      )
    ) {
      continue;
    }

    const entryType = resolveEntryType(entry.dirent);

    if (!shouldIncludeEntry(entryType, normalized)) {
      continue;
    }

    const isAccessible = await isEntryAccessibleByType(
      entry.path,
      entryType,
      rootDirectories,
      signal,
      accessDeps
    );
    if (!isAccessible) {
      state.skippedInaccessible++;
      continue;
    }

    handleEntry(entry, entryType, needsStats, normalized, state);
    if (state.truncated) break;
  }

  reportPeriodicProgress(onProgress, state.filesScanned, {
    total: normalized.maxFilesScanned,
    throttleModulo: 25,
    force: true,
  });
}

function isEntryIgnoredByGitignore(
  matcher: Awaited<ReturnType<typeof loadRootGitignore>>,
  root: string,
  entryPath: string,
  relativePath?: string
): boolean {
  if (!matcher) return false;
  return isIgnoredByGitignore(
    matcher,
    root,
    entryPath,
    relativePath ? { relativePath } : {}
  );
}

async function collectSearchResults(
  root: string,
  pattern: string,
  excludePatterns: readonly string[],
  normalized: NormalizedOptions,
  signal: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<CollectOutcome> {
  const needsStats = needsStatsForSort(normalized.sortBy);
  const stream = buildSearchStream(
    root,
    pattern,
    excludePatterns,
    normalized,
    needsStats
  );
  const state = createCollectState();
  const rootDirectories = [root];
  const accessDeps = {
    normalizePath,
    isPathWithinDirectories,
    isSensitivePath,
    validateSymlinkPath: validateExistingPathDetailed,
  };

  const gitignoreMatcher = normalized.respectGitignore
    ? await loadRootGitignore(root, signal)
    : null;

  await collectFromStream(
    stream,
    root,
    rootDirectories,
    gitignoreMatcher,
    normalized,
    needsStats,
    state,
    signal,
    accessDeps,
    onProgress
  );
  return buildCollectResult(state);
}

function buildSearchSummary(
  results: SearchResult[],
  filesScanned: number,
  truncated: boolean,
  stoppedReason: StopReason | undefined,
  skippedInaccessible: number
): SearchFilesResult['summary'] {
  const summary = {
    matched: results.length,
    truncated,
    skippedInaccessible,
    filesScanned,
  };
  return withOptionalStoppedReason(summary, stoppedReason);
}

interface Sortable {
  name?: string;
  size?: number;
  modified?: Date;
  path?: string;
}

function compareNameThenPath(a: Sortable, b: Sortable): number {
  const nameCompare = compareStringValues(a.name, b.name);
  if (nameCompare !== 0) return nameCompare;
  return compareStringValues(a.path, b.path);
}

function comparePathThenName(a: Sortable, b: Sortable): number {
  const pathCompare = compareStringValues(a.path, b.path);
  if (pathCompare !== 0) return pathCompare;
  return compareStringValues(a.name, b.name);
}

const SORT_COMPARATORS: Readonly<
  Record<SortBy, (a: Sortable, b: Sortable) => number>
> = {
  size: (a, b) =>
    compareOptionalNumberDesc(a.size, b.size, () => compareNameThenPath(a, b)),
  modified: (a, b) =>
    compareOptionalNumberDesc(
      a.modified?.getTime(),
      b.modified?.getTime(),
      () => compareNameThenPath(a, b)
    ),
  path: (a, b) => comparePathThenName(a, b),
  name: (a, b) => compareNameThenPath(a, b),
};

export function sortSearchResults(results: Sortable[], sortBy: SortBy): void {
  if (sortBy === 'name') {
    stableSortByDerivedString(
      results,
      (item) => path.basename(item.path ?? ''),
      (left, right) => comparePathThenName(left, right)
    );
    return;
  }

  const comparator = SORT_COMPARATORS[sortBy];
  results.sort(comparator);
}

async function runSearchFiles(
  root: string,
  pattern: string,
  excludePatterns: readonly string[],
  normalized: NormalizedOptions,
  signal: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<{ results: SearchResult[]; summary: SearchFilesResult['summary'] }> {
  const {
    results,
    filesScanned,
    truncated,
    stoppedReason,
    skippedInaccessible,
  } = await collectSearchResults(
    root,
    pattern,
    excludePatterns,
    normalized,
    signal,
    onProgress
  );

  sortSearchResults(results, normalized.sortBy);

  return {
    results,
    summary: buildSearchSummary(
      results,
      filesScanned,
      truncated,
      stoppedReason,
      skippedInaccessible
    ),
  };
}

export async function searchFiles(
  basePath: string,
  pattern: string,
  excludePatterns: readonly string[] = [],
  options: SearchFilesOptions = {}
): Promise<SearchFilesResult> {
  const normalized = normalizeSearchFilesOptions(options);
  return withTimedAbortSignal(
    options.signal,
    normalized.timeoutMs,
    async (signal) => {
      const root = await validateExistingDirectory(basePath, signal);
      const { results, summary } = await runSearchFiles(
        root,
        pattern,
        excludePatterns,
        normalized,
        signal,
        options.onProgress
      );

      return {
        basePath: root,
        pattern,
        results,
        summary,
      };
    }
  );
}

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
  const ml = options.multiline ? '1' : '0';
  return `${pattern}|${cs}|${ww}|${lit}|${ml}`;
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
  if (!cancelledRequests.has(id)) {
    return false;
  }
  cancelledRequests.delete(id);
  return true;
}

function markCancelledIfActive(id: number): void {
  if (activeRequests.has(id)) {
    cancelledRequests.add(id);
  }
}

function buildScanResponse(
  id: number,
  result: ScanResult['result']
): ScanResult {
  return {
    type: 'result',
    id,
    result,
  };
}

function buildErrorResponse(id: number, error: unknown): ScanError {
  return {
    type: 'error',
    id,
    error: formatUnknownErrorMessage(error),
  };
}

async function handleScanRequest(request: ScanRequest): Promise<void> {
  const {
    id,
    resolvedPath,
    requestedPath,
    pattern,
    matcherOptions,
    scanOptions,
    maxMatches,
  } = request;

  if (consumeCancelled(id)) return;
  activeRequests.add(id);

  const endMeasure = startPerfMeasure('searchWorker.scan', {
    maxMatches,
  });
  let ok = false;

  try {
    const matcher = getCachedMatcher(pattern, matcherOptions);

    const isCancelled = (): boolean => cancelledRequests.has(id);

    const result = await scanFileInWorker(
      resolvedPath,
      requestedPath,
      matcher,
      scanOptions,
      maxMatches,
      isCancelled,
      isProbablyBinary
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
  }
}

if (parentPort) {
  parentPort.on('message', handleMessage);

  const data = workerData as { debug?: boolean } | null;
  if (data?.debug) {
    console.error(`[SearchWorker] Started with threadId=${String(threadId)}`);
  }
}
