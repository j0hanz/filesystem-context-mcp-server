import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { z } from 'zod';

import RE2 from 're2';
import safeRegex from 'safe-regex2';

import type { ContentMatch, SearchContentResult } from '../../config.js';
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
  createTimedAbortSignal,
  isProbablyBinary,
  withAbort,
} from '../fs-helpers.js';
import { assertAllowedFileAccess, isSensitivePath } from '../path-policy.js';
import {
  isPathWithinDirectories,
  normalizePath,
  validateExistingDirectory,
  validateExistingPathDetailed,
} from '../path-validation.js';
import { withOptionalStoppedReason } from './common.js';
import { globEntries } from './glob-engine.js';

// --- Configuration & Schemas ---

const INTERNAL_MAX_RESULTS = 500;

export const MatcherOptionsSchema = z.strictObject({
  caseSensitive: z.boolean(),
  wholeWord: z.boolean(),
  isLiteral: z.boolean(),
});
export type MatcherOptions = z.infer<typeof MatcherOptionsSchema>;
export interface ScanFileOptions {
  maxFileSize: number;
  skipBinary: boolean;
  contextLines: number;
}

const SearchOptionsSchema = z.strictObject({
  filePattern: z.string().min(1),
  excludePatterns: z.array(z.string()),
  caseSensitive: z.boolean(),
  maxResults: z.number().int().nonnegative(),
  maxFileSize: z.number().int().nonnegative(),
  maxFilesScanned: z.number().int().nonnegative(),
  timeoutMs: z.number().int().nonnegative(),
  skipBinary: z.boolean(),
  contextLines: z.number().int().nonnegative(),
  wholeWord: z.boolean(),
  isLiteral: z.boolean(),
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
  maxResults: INTERNAL_MAX_RESULTS,
  maxFileSize: MAX_SEARCHABLE_FILE_SIZE,
  maxFilesScanned: DEFAULT_SEARCH_MAX_FILES,
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  skipBinary: true,
  contextLines: 0,
  wholeWord: false,
  isLiteral: true,
  includeHidden: false,
  baseNameMatch: false,
  caseSensitiveFileMatch: true,
};

const ERROR_SCAN_CANCELLED = 'Scan cancelled';
const ERROR_WORKER_POOL_CLOSED = 'Worker pool closed';

// --- Helpers ---

function resolveOptions(options: SearchContentOptions): ResolvedOptions {
  const rest = { ...options };
  delete rest.signal;
  delete rest.onProgress;
  const merged = { ...DEFAULTS, ...rest };
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

// --- Matcher Logic ---

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

function validatePattern(pattern: string, options: MatcherOptions): void {
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

function buildRegexMatcher(final: string, caseSensitive: boolean): Matcher {
  const regex = new RE2(final, caseSensitive ? 'g' : 'gi');
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
  return buildRegexMatcher(final, options.caseSensitive);
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

function buildSearchResult(
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
  return !isSourceContext;
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
  const scanOpts: ScanFileOptions = {
    maxFileSize: opts.maxFileSize,
    skipBinary: opts.skipBinary,
    contextLines: opts.contextLines,
  };

  for await (const file of files) {
    if (signal.aborted) {
      summary.truncated = true;
      summary.stoppedReason = 'timeout';
      break;
    }
    if (matches.length >= opts.maxResults) {
      summary.truncated = true;
      summary.stoppedReason = 'maxResults';
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

      if (result.matched) summary.filesMatched++;
      if (result.skippedBinary) summary.skippedBinary++;
      if (result.skippedTooLarge) summary.skippedTooLarge++;

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
    if (res.matched) summary.filesMatched++;
    if (res.skippedBinary) summary.skippedBinary++;
    if (res.skippedTooLarge) summary.skippedTooLarge++;

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

function reportSearchProgress(
  onProgress: SearchContentOptions['onProgress'],
  current: number,
  total: number,
  force = false
): void {
  if (!onProgress || current === 0) return;
  if (!force && current % 25 !== 0) return;
  onProgress({ current, total });
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
  const scanOpts: ScanFileOptions = {
    maxFileSize: opts.maxFileSize,
    skipBinary: opts.skipBinary,
    contextLines: opts.contextLines,
  };
  const matcherOpts: MatcherOptions = {
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
    isLiteral: opts.isLiteral,
  };

  const pending = new Set<ScanTask>();
  const iterator = files[Symbol.asyncIterator]();
  let exhausted = false;

  const onAbort = (): void => {
    summary.truncated = true;
    summary.stoppedReason = 'timeout';
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
    summary.truncated = true;
    summary.stoppedReason = 'timeout';
  } else if (matches.length >= opts.maxResults) {
    summary.truncated = true;
    summary.stoppedReason = 'maxResults';
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
      maxFileSize: opts.maxFileSize,
      skipBinary: opts.skipBinary,
      contextLines: opts.contextLines,
    },
    signal,
    opts.maxResults
  );

  if (result.matched) summary.filesMatched = 1;

  return buildSearchResult(
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

  const stream = globEntries({
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
  });

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
      reportSearchProgress(onProgress, scanned, opts.maxFilesScanned);

      yield { resolvedPath: normalized, requestedPath: entry.path };
    }

    reportSearchProgress(onProgress, scanned, opts.maxFilesScanned, true);
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
  };
  validatePattern(pattern, matcherOpts);

  const matches = shouldUseWorkers()
    ? await executeParallel(countingStream(), pattern, opts, signal, summary)
    : await executeSequential(countingStream(), pattern, opts, signal, summary);

  return buildSearchResult(root, pattern, opts.filePattern, matches, summary);
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
  const { signal, cleanup } = createTimedAbortSignal(
    options.signal,
    opts.timeoutMs
  );

  try {
    const details = await validateExistingPathDetailed(basePath, signal);
    const stats = await withAbort(fsp.stat(details.resolvedPath), signal);

    if (stats.isFile()) {
      return await searchSingleFile(details, opts, pattern, signal);
    }

    if (!stats.isDirectory()) {
      throw new McpError(
        ErrorCode.E_INVALID_INPUT,
        'Path must be file or directory',
        basePath
      );
    }

    return await searchDirectory(
      details,
      opts,
      pattern,
      signal,
      options.onProgress
    );
  } catch (error: unknown) {
    if (isTimeoutLikeError(error)) {
      const timeoutSummary = createScanSummary();
      timeoutSummary.truncated = true;
      timeoutSummary.stoppedReason = 'timeout';
      return buildSearchResult(
        basePath,
        pattern,
        opts.filePattern,
        [],
        timeoutSummary
      );
    }
    throw error;
  } finally {
    cleanup();
  }
}
