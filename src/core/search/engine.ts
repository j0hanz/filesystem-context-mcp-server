import { AsyncResource } from 'node:async_hooks';
import { open } from 'node:fs/promises';
import { debuglog } from 'node:util';
import { parentPort, threadId, Worker, workerData } from 'node:worker_threads';

import RE2 from 're2';

import { ErrorCode, formatUnknownErrorMessage, FsError } from '../errors.js';
import type { GuardedFileSystem, Stats } from '../fs.js';
import { globEntries } from '../fs.js';
import { escapeRegexLiteral } from '../primitives.js';
import { parseEnvInt, SEARCH_WORKERS } from '../util.js';

// Re-export the RE2 type so callers keep `Map<string, Regex>` / `Regex | undefined`
// signatures without importing the `re2` package directly.
export type { default as Regex } from 're2';

// Constants
const ERROR_SCAN_CANCELLED = 'Scan cancelled';
const ERROR_WORKER_POOL_CLOSED = 'Worker pool closed';
const SEARCH_WORKER_RESOURCE_TYPE = 'SearchWorkerTask';
const SEARCH_WORKER_NAME_PREFIX = 'filesystem-search';
const MAX_LINES_PER_FILE = 100_000;
const SCAN_REQUEST_TIMEOUT_MS = parseEnvInt(
  'FS_CONTEXT_SCAN_REQUEST_TIMEOUT_MS',
  30_000,
  1_000,
  300_000,
);

const isSourceContext =
  import.meta.url.endsWith('.ts') || process.execArgv.some((a) => a.includes('tsx'));
const WORKER_SCRIPT_URL = new URL(import.meta.url);

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface SearchOptions {
  pattern: string;
  path?: string;
  filePattern?: string;
  excludePatterns?: string[];
  caseSensitive?: boolean;
  wholeWord?: boolean;
  isLiteral?: boolean;
  maxResults?: number;
  maxFileSize?: number;
  maxFilesScanned?: number;
  timeoutMs?: number;
  skipBinary?: boolean;
  contextBefore?: number;
  contextAfter?: number;
  fileSearch?: boolean;
  includeStats?: boolean;
  signal?: AbortSignal;
  maxDepth?: number;
  baseNameMatch?: boolean;
  includeHidden?: boolean;
  respectGitignore?: boolean;
  fuzzy?: boolean;
}

interface ContentMatch {
  readonly line: number;
  readonly content: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

interface FileMatch {
  readonly filePath: string;
  readonly matches: readonly ContentMatch[];
  readonly size?: number;
  readonly modified?: Date;
}

export interface SearchResult {
  readonly filesMatched: readonly FileMatch[];
  readonly summary: {
    readonly filesScanned: number;
    readonly filesMatched: number;
    readonly matchesCount: number;
    readonly truncated: boolean;
    readonly truncatedReason?: 'maxResults' | 'maxFiles';
    readonly skippedFiles?: number;
  };
}

export interface MatcherOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  isLiteral: boolean;
  fuzzy?: boolean;
}

interface ScanFileOptions {
  maxFileSize: number;
  skipBinary: boolean;
  contextBefore: number;
  contextAfter: number;
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

export interface ScanTask {
  id: number;
  promise: Promise<WorkerScanResult>;
  cancel: () => void;
}

interface PendingWorkerRequest {
  resolve: (result: WorkerScanResult) => void;
  reject: (error: Error) => void;
  workerIndex: number;
  worker: Worker;
}

// ─── Worker Task Resource ───────────────────────────────────────────────────

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

// ─── Search Worker Pool ─────────────────────────────────────────────────────

export class SearchWorkerPool {
  private workers: (Worker | undefined)[];
  private pending = new Map<number, PendingWorkerRequest>();
  private pendingTimeouts = new Map<number, ReturnType<typeof setTimeout>>();
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

  private rejectPendingForWorker(worker: Worker, error: Error): void {
    for (const [id, pendingRequest] of this.pending) {
      if (pendingRequest.worker !== worker) continue;
      this.pending.delete(id);
      clearTimeout(this.pendingTimeouts.get(id));
      this.pendingTimeouts.delete(id);
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
      clearTimeout(this.pendingTimeouts.get(msg.id));
      this.pendingTimeouts.delete(msg.id);
      if (msg.type === 'result') p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    });

    worker.on('messageerror', (error: unknown) => {
      const normalized = this.normalizeWorkerError(
        error,
        `Worker ${String(index)} failed to deserialize a message`,
      );
      this.rejectPendingForWorker(worker, normalized);
      this.retireWorker(index, worker);
    });

    worker.on('error', (error: Error) => {
      this.rejectPendingForWorker(worker, error);
      this.retireWorker(index, worker);
    });

    worker.on('exit', (exitCode: number) => {
      if (this.closed) return;
      this.rejectPendingForWorker(
        worker,
        new Error(`Worker ${String(index)} exited with code ${String(exitCode)}`),
      );
      this.markWorkerAsUnavailable(index, worker);
    });
    worker.unref();
    return worker;
  }

  private getLeastBusyWorkerIndex(): number {
    const counts = new Array<number>(this.size).fill(0);
    for (const p of this.pending.values()) {
      counts[p.workerIndex] = (counts[p.workerIndex] ?? 0) + 1;
    }

    let best = 0;
    for (let i = 1; i < this.size; i++) {
      if ((counts[i] ?? 0) < (counts[best] ?? 0)) best = i;
    }
    return best;
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
        worker,
      };

      this.pending.set(id, pendingRequest);
      this.pendingTimeouts.set(
        id,
        setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          this.pendingTimeouts.delete(id);
          try {
            worker.postMessage({ type: 'cancel', id });
          } catch {
            this.retireWorker(workerIndex, worker);
          }
          pendingRequest.reject(new Error(`Scan request ${String(id)} timed out`));
        }, SCAN_REQUEST_TIMEOUT_MS),
      );

      try {
        worker.postMessage({ type: 'scan', id, ...req });
      } catch (error: unknown) {
        clearTimeout(this.pendingTimeouts.get(id));
        this.pendingTimeouts.delete(id);
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
    clearTimeout(this.pendingTimeouts.get(id));
    this.pendingTimeouts.delete(id);
    try {
      worker.postMessage({ type: 'cancel', id });
    } catch {
      this.retireWorker(entry.workerIndex, worker);
    }
    entry.reject(new Error(ERROR_SCAN_CANCELLED));
  }

  // Callers must not call scan() after close() has been called.
  scan(req: WorkerScanRequest): ScanTask {
    if (this.closed) throw new Error(ERROR_WORKER_POOL_CLOSED);

    const id = this.nextRequestId++;
    const workerIndex = this.getLeastBusyWorkerIndex();

    const worker = this.getWorker(workerIndex);

    const promise = this.createWorkerScanPromise(id, worker, workerIndex, req);
    promise.catch(() => {
      /* ignore cancellation/error rejections; handled by down-stream consumers */
    }); // Prevent unhandled rejection crashes

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
    for (const t of this.pendingTimeouts.values()) clearTimeout(t);
    this.pendingTimeouts.clear();
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

// ─── Search Matchers ────────────────────────────────────────────────────────

export interface RegexCompileOptions {
  caseSensitive?: boolean; // default false → flag 'i'
  global?: boolean; // default false → flag 'g'
  wholeWord?: boolean; // wrap \b…\b
  literal?: boolean; // escape pattern before compiling
}

// Single owned RE2 compiler: derives flags, applies literal/wholeWord transforms,
// and wraps construction failures in the canonical INVALID_PATTERN error.
export function compileRegex(pattern: string, options: RegexCompileOptions = {}): RE2 {
  const escaped = options.literal ? escapeRegexLiteral(pattern) : pattern;
  let final = escaped;
  if (options.wholeWord) {
    const startBoundary = /^\w/.test(escaped) ? '\\b' : '';
    const endBoundary = /\w$/.test(escaped) ? '\\b' : '';
    final = `${startBoundary}${escaped}${endBoundary}`;
  }
  const flags = `${options.global ? 'g' : ''}${options.caseSensitive ? '' : 'i'}`;
  try {
    return new RE2(final, flags);
  } catch (error) {
    throw new FsError({
      code: ErrorCode.INVALID_PATTERN,
      message: `Invalid regex pattern: ${formatUnknownErrorMessage(error)} (RE2: no lookahead/lookbehind/backrefs)`,
    });
  }
}

function countRegexLineMatches(regex: RE2, line: string): number {
  regex.lastIndex = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    count++;
    if (m[0].length === 0) regex.lastIndex++;
  }
  return count;
}

export interface ContentMatcher {
  matchCount(line: string): number;
}

class RegexContentMatcher implements ContentMatcher {
  private readonly regex: RE2;

  constructor(pattern: string, options: MatcherOptions) {
    this.regex = compileRegex(pattern, {
      caseSensitive: options.caseSensitive,
      global: true,
      wholeWord: options.wholeWord,
      literal: options.isLiteral,
    });
  }

  matchCount(line: string): number {
    return countRegexLineMatches(this.regex, line);
  }
}

class LiteralContentMatcher implements ContentMatcher {
  private readonly needle: string;

  constructor(pattern: string) {
    this.needle = pattern;
  }

  matchCount(line: string): number {
    if (this.needle.length === 0 || line.length === 0) return 0;
    let count = 0;
    let pos = line.indexOf(this.needle);
    while (pos !== -1) {
      count++;
      pos = line.indexOf(this.needle, pos + this.needle.length);
    }
    return count;
  }
}

class EmptyContentMatcher implements ContentMatcher {
  matchCount(): number {
    return 0;
  }
}

class FuzzyContentMatcher implements ContentMatcher {
  private readonly pattern: string;
  private readonly caseSensitive: boolean;

  constructor(pattern: string, caseSensitive: boolean) {
    this.pattern = pattern;
    this.caseSensitive = caseSensitive;
  }

  matchCount(line: string): number {
    return isFuzzyMatch(line, this.pattern, this.caseSensitive) ? 1 : 0;
  }
}

function isFuzzyMatch(text: string, pattern: string, caseSensitive: boolean): boolean {
  const t = caseSensitive ? text : text.toLowerCase();
  const p = caseSensitive ? pattern : pattern.toLowerCase();
  if (p.length === 0) return false;
  if (t.includes(p)) return true; // fast path: exact substring

  // Prevent DoS from large patterns (Levenshtein is O(m·n) per window) or long lines.
  if (p.length > 50) return false;
  if (t.length > 1000) return false;

  const maxDist = Math.max(1, Math.floor(p.length / 4));
  const minLen = Math.max(1, p.length - maxDist);
  const maxLen = Math.min(t.length, p.length + maxDist);

  const dp = new Array<number>(p.length + 1);

  for (let len = minLen; len <= maxLen; len++) {
    for (let start = 0; start <= t.length - len; start++) {
      const win = t.slice(start, start + len);
      if (levenshtein(win, p, maxDist, dp) <= maxDist) return true;
    }
  }
  return false;
}

function levenshtein(a: string, b: string, maxDist: number, dp: number[]): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > maxDist) return maxDist + 1;

  for (let i = 0; i <= n; i++) dp[i] = i;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0] ?? 0;
    dp[0] = i;
    let minInRow = i;
    const charA = a[i - 1];
    for (let j = 1; j <= n; j++) {
      const temp = dp[j] ?? 0;
      const val = charA === b[j - 1] ? prev : 1 + Math.min(prev, temp, dp[j - 1] ?? 0);
      dp[j] = val;
      prev = temp;
      if (val < minInRow) {
        minInRow = val;
      }
    }
    if (minInRow > maxDist) {
      return maxDist + 1;
    }
  }
  return dp[n] ?? 0;
}

export function buildMatcher(pattern: string, options: MatcherOptions): ContentMatcher {
  if (options.fuzzy) return new FuzzyContentMatcher(pattern, options.caseSensitive);
  if (options.isLiteral && pattern.length === 0) return new EmptyContentMatcher();
  if (options.isLiteral && !options.wholeWord && options.caseSensitive) {
    return new LiteralContentMatcher(pattern);
  }
  return new RegexContentMatcher(pattern, options);
}

// ─── Execute Search API ─────────────────────────────────────────────────────

let poolInstance: SearchWorkerPool | null = null;
function getPool(): SearchWorkerPool {
  if (!poolInstance) {
    const debug = process.env['FS_CONTEXT_SEARCH_WORKERS_DEBUG'] === '1';
    poolInstance = new SearchWorkerPool(SEARCH_WORKERS, debug);
  }
  return poolInstance;
}

export async function shutdownSearchWorkerPool(): Promise<void> {
  if (poolInstance) {
    await poolInstance.close();
    poolInstance = null;
  }
}

// ─── Search Helpers ──────────────────────────────────────────────────────────

interface ResolvedSearchOptions {
  pattern: string;
  isLiteral: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  skipBinary: boolean;
  maxFileSize: number;
  maxResults: number;
  maxFilesScanned: number;
}

function resolveSearchOptions(options: SearchOptions): ResolvedSearchOptions {
  return {
    pattern: options.pattern,
    isLiteral: options.isLiteral ?? false,
    caseSensitive: options.caseSensitive ?? false,
    wholeWord: options.wholeWord ?? false,
    skipBinary: options.skipBinary ?? true,
    maxFileSize: options.maxFileSize ?? 10 * 1024 * 1024, // 10 MB
    maxResults: options.maxResults ?? 500,
    maxFilesScanned: options.maxFilesScanned ?? 1000,
  };
}

interface ScanFile {
  resolvedPath: string;
  requestedPath: string;
  stats?: Stats;
}

async function collectFilesToScan(
  fs: GuardedFileSystem,
  options: SearchOptions,
  resolved: Awaited<ReturnType<GuardedFileSystem['pathGuard']['validateExistingPathDetailed']>>,
  targetStats: Stats,
  maxFilesScanned: number,
  caseSensitive: boolean,
): Promise<{ files: ScanFile[]; wasCapped: boolean }> {
  if (targetStats.isFile()) {
    return {
      files: [
        {
          resolvedPath: resolved.resolvedPath,
          requestedPath: resolved.requestedPath,
          stats: targetStats,
        },
      ],
      wasCapped: false,
    };
  }

  if (!targetStats.isDirectory()) return { files: [], wasCapped: false };

  const files: ScanFile[] = [];
  const globStream = globEntries({
    cwd: resolved.resolvedPath,
    pattern: options.filePattern ?? '**/*',
    excludePatterns: options.excludePatterns ?? [],
    includeHidden: options.includeHidden ?? false,
    baseNameMatch: options.baseNameMatch ?? false,
    caseSensitiveMatch: caseSensitive,
    followSymbolicLinks: false,
    onlyFiles: true,
    stats: options.includeStats ?? false,
    suppressErrors: true,
    respectGitignore: options.respectGitignore !== false,
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
  });

  for await (const entry of globStream) {
    if (files.length >= maxFilesScanned) break;
    if (fs.pathGuard.isSensitive(entry.path)) continue;
    files.push({
      resolvedPath: entry.path,
      requestedPath: entry.relativePath ?? entry.path,
      ...(entry.stats !== undefined ? { stats: entry.stats } : {}),
    });
  }
  return { files, wasCapped: files.length >= maxFilesScanned };
}

function buildFileMatch(file: ScanFile, matches: readonly ContentMatch[]): FileMatch {
  const size = file.stats?.isFile() === true ? file.stats.size : undefined;
  const modified = file.stats?.mtime;
  return {
    filePath: file.resolvedPath,
    matches,
    ...(size !== undefined ? { size } : {}),
    ...(modified !== undefined ? { modified } : {}),
  };
}

function isBinaryBuffer(buffer: Buffer, bytesRead: number): boolean {
  for (let i = 0; i < bytesRead; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

interface PendingMatch {
  line: number;
  content: string;
  before: string[];
  after: string[];
  remainingAfter: number;
}

async function scanStreamForMatches(
  lineIterable: AsyncIterable<string>,
  matcher: ContentMatcher,
  contextBefore: number,
  contextAfter: number,
  limit: number,
  signalCheck?: () => boolean,
): Promise<{ matches: ContentMatch[]; matchesFound: number }> {
  const matches: ContentMatch[] = [];
  let matchesFound = 0;

  const beforeWindow: string[] = [];
  const pendingMatches: PendingMatch[] = [];

  let lineIndex = 0;

  for await (const line of lineIterable) {
    if (signalCheck?.()) {
      break;
    }
    if (matchesFound >= limit && pendingMatches.length === 0) {
      break;
    }

    lineIndex++;

    // 1. Update pending matches with the new line as "after" context
    for (let i = 0; i < pendingMatches.length; i++) {
      const pending = pendingMatches[i];
      if (pending && pending.remainingAfter > 0) {
        pending.after.push(line);
        pending.remainingAfter--;
        if (pending.remainingAfter === 0) {
          matches.push({
            line: pending.line,
            content: pending.content,
            before: pending.before,
            after: pending.after,
          });
          pendingMatches.splice(i, 1);
          i--;
        }
      }
    }

    // 2. Check if the current line matches (only if we haven't hit the limit)
    if (matchesFound < limit && matcher.matchCount(line) > 0) {
      matchesFound++;
      const matchObj: PendingMatch = {
        line: lineIndex,
        content: line,
        before: [...beforeWindow],
        after: [],
        remainingAfter: contextAfter,
      };

      if (contextAfter === 0) {
        matches.push({
          line: matchObj.line,
          content: matchObj.content,
          before: matchObj.before,
          after: matchObj.after,
        });
      } else {
        pendingMatches.push(matchObj);
      }
    }

    // 3. Update the before sliding window
    if (contextBefore > 0) {
      beforeWindow.push(line);
      if (beforeWindow.length > contextBefore) {
        beforeWindow.shift();
      }
    }

    if (lineIndex >= MAX_LINES_PER_FILE) {
      break;
    }
  }

  // 4. Finalize any remaining pending matches (file ended before getting all contextAfter lines)
  for (const pending of pendingMatches) {
    matches.push({
      line: pending.line,
      content: pending.content,
      before: pending.before,
      after: pending.after,
    });
  }

  return { matches, matchesFound };
}

export async function executeSearch(
  fs: GuardedFileSystem,
  options: SearchOptions,
): Promise<SearchResult> {
  const opts = resolveSearchOptions(options);

  const resolvedTarget = await fs.pathGuard.validateExistingPathDetailed(options.path ?? '.');
  const { stats: targetStats } = await fs.stat(resolvedTarget.resolvedPath);

  const { files: filesToScan, wasCapped: filesCapped } = await collectFilesToScan(
    fs,
    options,
    resolvedTarget,
    targetStats,
    opts.maxFilesScanned,
    opts.caseSensitive,
  );

  if (options.fileSearch) {
    const truncatedByResults = filesToScan.length > opts.maxResults;
    const filesToReturn = truncatedByResults ? filesToScan.slice(0, opts.maxResults) : filesToScan;
    const filesMatched = filesToReturn.map((f) => buildFileMatch(f, []));
    const truncated = truncatedByResults || filesCapped;
    const truncatedReason = truncatedByResults
      ? ('maxResults' as const)
      : filesCapped
        ? ('maxFiles' as const)
        : undefined;

    return {
      filesMatched,
      summary: {
        filesScanned: filesToScan.length,
        filesMatched: filesMatched.length,
        matchesCount: 0,
        truncated,
        ...(truncatedReason !== undefined ? { truncatedReason } : {}),
      },
    };
  }

  const matcherOptions: MatcherOptions = {
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
    isLiteral: opts.isLiteral,
    ...(options.fuzzy !== undefined ? { fuzzy: options.fuzzy } : {}),
  };

  // Compile / validate the regex pattern early on the main thread (throws if invalid)
  buildMatcher(opts.pattern, matcherOptions);

  const filesMatched: FileMatch[] = [];
  let matchesCount = 0;
  let filesScanned = 0;
  let skippedFiles = 0;

  const shouldUseWorkers = !isSourceContext && SEARCH_WORKERS >= 2;

  if (shouldUseWorkers) {
    const pool = getPool();
    const pending = new Set<ScanTask>();
    const taskToFile = new Map<ScanTask, ScanFile>();
    const taskPromises = new Map<
      ScanTask,
      Promise<{ task: ScanTask; result: WorkerScanResult | null; error: unknown }>
    >();
    const fileIterator = filesToScan[Symbol.iterator]();
    let iteratorDone = false;

    const fillPool = () => {
      while (pending.size < SEARCH_WORKERS && !iteratorDone) {
        const next = fileIterator.next();
        if (next.done) {
          iteratorDone = true;
          break;
        }
        const file = next.value;
        const remainingMatches = opts.maxResults - matchesCount;
        if (remainingMatches <= 0) break;
        const task = pool.scan({
          resolvedPath: file.resolvedPath,
          requestedPath: file.requestedPath,
          pattern: opts.pattern,
          matcherOptions,
          scanOptions: {
            maxFileSize: opts.maxFileSize,
            skipBinary: opts.skipBinary,
            contextBefore: options.contextBefore ?? 0,
            contextAfter: options.contextAfter ?? 0,
          },
          maxMatches: remainingMatches,
        });
        taskToFile.set(task, file);
        pending.add(task);
        taskPromises.set(
          task,
          task.promise.then(
            (result) => ({ task, result, error: null }),
            (error: unknown) => ({ task, result: null, error }),
          ),
        );
      }
    };

    const onAbort = () => {
      for (const task of pending) task.cancel();
    };

    try {
      if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
      fillPool();
      while (pending.size > 0 && matchesCount < opts.maxResults) {
        if (options.signal?.aborted) break;
        const raceCandidates = Array.from(pending).map((task) => {
          const p = taskPromises.get(task);
          if (!p) throw new Error('Race promise not found');
          return p;
        });
        const winner = await Promise.race(raceCandidates);
        pending.delete(winner.task);
        taskPromises.delete(winner.task);
        filesScanned++;
        const file = taskToFile.get(winner.task);
        taskToFile.delete(winner.task);

        if (winner.error !== null) {
          skippedFiles++;
          workerLog(
            'scan error for %s: %s',
            file?.resolvedPath,
            formatUnknownErrorMessage(winner.error),
          );
        } else if (winner.result?.matched === true && file !== undefined) {
          const remaining = opts.maxResults - matchesCount;
          if (remaining > 0) {
            const matchesToTake = winner.result.matches.slice(0, remaining);
            if (matchesToTake.length > 0) {
              filesMatched.push(buildFileMatch(file, matchesToTake));
              matchesCount += matchesToTake.length;
            }
          }
        }
        fillPool();
      }
    } finally {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      // Tasks still in flight when the loop exits (e.g. maxResults reached) were
      // dispatched to workers and partially scanned; count them before cancelling
      // so filesScanned reflects every file actually touched.
      filesScanned += pending.size;
      for (const task of pending) task.cancel();
    }
  } else {
    const matcher = buildMatcher(opts.pattern, matcherOptions);
    const contextBefore = options.contextBefore ?? 0;
    const contextAfter = options.contextAfter ?? 0;

    for (const file of filesToScan) {
      if (options.signal?.aborted || matchesCount >= opts.maxResults) break;
      filesScanned++;

      try {
        const fileHandle = await fs.open(file.resolvedPath, 'r');
        await using _disposer = fileHandle;
        const stats = await fileHandle.stat();

        if (stats.size > opts.maxFileSize) continue;

        if (opts.skipBinary) {
          const buffer = Buffer.alloc(512);
          const { bytesRead } = await fileHandle.read(buffer, 0, 512, 0);
          if (isBinaryBuffer(buffer, bytesRead)) continue;
        }

        const { matches, matchesFound } = await scanStreamForMatches(
          fileHandle.readLines({ encoding: 'utf-8' }),
          matcher,
          contextBefore,
          contextAfter,
          opts.maxResults - matchesCount,
          () => options.signal?.aborted ?? false,
        );
        matchesCount += matchesFound;
        if (matches.length > 0) filesMatched.push(buildFileMatch(file, matches));
      } catch (err: unknown) {
        skippedFiles++;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
          workerLog(
            'unexpected error scanning %s: %s',
            file.resolvedPath,
            formatUnknownErrorMessage(err),
          );
        }
      }
    }
  }

  const truncatedByResults = matchesCount >= opts.maxResults;
  const truncated = truncatedByResults || filesCapped;
  const truncatedReason = truncatedByResults
    ? ('maxResults' as const)
    : filesCapped
      ? ('maxFiles' as const)
      : undefined;

  return {
    filesMatched,
    summary: {
      filesScanned,
      filesMatched: filesMatched.length,
      matchesCount,
      truncated,
      ...(truncatedReason !== undefined ? { truncatedReason } : {}),
      ...(skippedFiles > 0 ? { skippedFiles } : {}),
    },
  };
}

// ─── Worker Thread Execution Setup ──────────────────────────────────────────

interface CancelRequest {
  type: 'cancel';
  id: number;
}

interface ShutdownRequest {
  type: 'shutdown';
}

type WorkerRequest = ScanRequest | CancelRequest | ShutdownRequest;

const matcherCache = new Map<string, ContentMatcher>();
const MAX_MATCHER_CACHE_SIZE = 100;

function getCachedMatcher(pattern: string, options: MatcherOptions): ContentMatcher {
  const key = `${pattern}|${options.caseSensitive ? 1 : 0}|${options.wholeWord ? 1 : 0}|${options.isLiteral ? 1 : 0}|${options.fuzzy ? 1 : 0}`;
  const cached = matcherCache.get(key);
  // LRU refresh: delete then re-insert to move to end of insertion order
  matcherCache.delete(key);
  const matcher = cached ?? buildMatcher(pattern, options);
  matcherCache.set(key, matcher);
  if (matcherCache.size > MAX_MATCHER_CACHE_SIZE) {
    const oldest = matcherCache.keys().next().value;
    if (oldest !== undefined) matcherCache.delete(oldest);
  }
  return matcher;
}

const cancelledRequests = new Set<number>();
const activeRequests = new Set<number>();
let shuttingDown = false;

function maybeFinishShutdown(): void {
  if (!shuttingDown || activeRequests.size > 0) return;
  try {
    parentPort?.close();
  } catch {
    /* port already closed */
  }
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
  const { id, resolvedPath, pattern, matcherOptions, scanOptions, maxMatches } = request;

  if (consumeCancelled(id)) return;
  activeRequests.add(id);

  try {
    const matcher = getCachedMatcher(pattern, matcherOptions);

    const handle = await open(resolvedPath, 'r');
    await using _disposer = handle;

    const stats = await handle.stat();
    if (stats.size > scanOptions.maxFileSize) {
      if (consumeCancelled(id)) return;
      parentPort?.postMessage(
        buildScanResponse(id, {
          matches: [],
          matched: false,
          skippedTooLarge: true,
          skippedBinary: false,
        }),
      );
      return;
    }

    if (scanOptions.skipBinary) {
      const buffer = Buffer.alloc(512);
      const { bytesRead } = await handle.read(buffer, 0, 512, 0);
      if (isBinaryBuffer(buffer, bytesRead)) {
        if (consumeCancelled(id)) return;
        parentPort?.postMessage(
          buildScanResponse(id, {
            matches: [],
            matched: false,
            skippedTooLarge: false,
            skippedBinary: true,
          }),
        );
        return;
      }
    }

    const { matches } = await scanStreamForMatches(
      handle.readLines({ encoding: 'utf-8' }),
      matcher,
      scanOptions.contextBefore,
      scanOptions.contextAfter,
      maxMatches,
      () => cancelledRequests.has(id),
    );

    if (consumeCancelled(id)) return;
    parentPort?.postMessage(
      buildScanResponse(id, {
        matches,
        matched: matches.length > 0,
        skippedTooLarge: false,
        skippedBinary: false,
      }),
    );
  } catch (err) {
    if (consumeCancelled(id)) {
      workerLog('scan %d cancelled with error: %s', id, formatUnknownErrorMessage(err));
      return;
    }
    parentPort?.postMessage(buildErrorResponse(id, err));
  } finally {
    activeRequests.delete(id);
    cancelledRequests.delete(id);
    maybeFinishShutdown();
  }
}

function handleMessage(message: WorkerRequest): void {
  switch (message.type) {
    case 'scan':
      if (shuttingDown) return;
      handleScanRequest(message).catch((err: unknown) => {
        parentPort?.postMessage(buildErrorResponse(message.id, err));
      });
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
