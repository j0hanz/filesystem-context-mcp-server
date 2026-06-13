import { AsyncResource } from 'node:async_hooks';
import { debuglog } from 'node:util';
import { parentPort, threadId, Worker, workerData } from 'node:worker_threads';

import RE2 from 're2';

import { formatUnknownErrorMessage } from '../errors.js';
import type { GuardedFileSystem, Stats } from '../fs.js';
import { globEntries } from '../fs.js';
import { SEARCH_WORKERS } from '../util.js';
import type { ContentMatch, FileMatch, SearchOptions, SearchResult } from './types.js';

// Constants
const ERROR_SCAN_CANCELLED = 'Scan cancelled';
const ERROR_WORKER_POOL_CLOSED = 'Worker pool closed';
const SEARCH_WORKER_RESOURCE_TYPE = 'SearchWorkerTask';
const SEARCH_WORKER_NAME_PREFIX = 'filesystem-search';

const isSourceContext =
  import.meta.url.endsWith('.ts') || process.execArgv.some((a) => a.includes('tsx'));
const WORKER_SCRIPT_URL = new URL(import.meta.url);

// ─── Interfaces ─────────────────────────────────────────────────────────────

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

// ─── Search Matchers ────────────────────────────────────────────────────────

function buildRegexPattern(pattern: string, options: MatcherOptions): string {
  const escaped = options.isLiteral ? escapeRegex(pattern) : pattern;
  return options.wholeWord ? `\\b${escaped}\\b` : escaped;
}

function countRegexLineMatches(regex: RE2, line: string): number {
  regex.lastIndex = 0;
  let count = 0;
  while (regex.exec(line) !== null) {
    count++;
    if (regex.lastIndex === 0) regex.lastIndex++;
  }
  return count;
}

export interface ContentMatcher {
  matchCount(line: string): number;
}

class RegexContentMatcher implements ContentMatcher {
  private readonly regex: RE2;

  constructor(pattern: string, options: MatcherOptions) {
    const final = buildRegexPattern(pattern, options);
    const flags = options.caseSensitive ? 'g' : 'gi';
    this.regex = new RE2(final, flags);
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

  const maxDist = Math.max(1, Math.floor(p.length / 4));
  const minLen = Math.max(1, p.length - maxDist);
  const maxLen = Math.min(t.length, p.length + maxDist);

  for (let len = minLen; len <= maxLen; len++) {
    for (let start = 0; start <= t.length - len; start++) {
      const win = t.slice(start, start + len);
      if (levenshtein(win, p) <= maxDist) return true;
    }
  }
  return false;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0] ?? 0;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j] ?? 0;
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j] ?? 0, dp[j - 1] ?? 0);
      prev = temp;
    }
  }
  return dp[n] ?? 0;
}

export function buildMatcher(pattern: string, options: MatcherOptions): ContentMatcher {
  if (options.fuzzy) {
    return new FuzzyContentMatcher(pattern, options.caseSensitive);
  }
  if (options.isLiteral && pattern.length === 0) {
    return new EmptyContentMatcher();
  }
  if (options.isLiteral && !options.wholeWord) {
    if (!options.caseSensitive) {
      return new RegexContentMatcher(pattern, { ...options, isLiteral: true });
    }
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

export async function executeSearch(
  fs: GuardedFileSystem,
  options: SearchOptions,
): Promise<SearchResult> {
  const searchPath = options.path ?? '.';
  const pattern = options.pattern;
  const isLiteral = options.isLiteral ?? false;
  const caseSensitive = options.caseSensitive ?? false;
  const wholeWord = options.wholeWord ?? false;
  const skipBinary = options.skipBinary ?? true;
  const maxFileSize = options.maxFileSize ?? 10 * 1024 * 1024; // 10MB
  const maxResults = options.maxResults ?? 500;
  const maxFilesScanned = options.maxFilesScanned ?? 1000;

  // Validate the search path first using GuardedFileSystem's stat
  const resolvedTarget = await fs.pathGuard.validateExistingPathDetailed(searchPath);
  const { stats: targetStats } = await fs.stat(resolvedTarget.resolvedPath);

  const filesToScan: { resolvedPath: string; requestedPath: string; stats?: Stats }[] = [];

  if (targetStats.isFile()) {
    filesToScan.push({
      resolvedPath: resolvedTarget.resolvedPath,
      requestedPath: resolvedTarget.requestedPath,
      stats: targetStats,
    });
  } else if (targetStats.isDirectory()) {
    // Walk directory using globEntries
    const excludePatterns = options.excludePatterns ?? [];
    const globStream = globEntries({
      cwd: resolvedTarget.resolvedPath,
      pattern: options.filePattern ?? '**/*',
      excludePatterns,
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
      if (filesToScan.length >= maxFilesScanned) break;
      // Validate the path is not sensitive
      if (fs.pathGuard.isSensitive(entry.path)) continue;
      filesToScan.push({
        resolvedPath: entry.path,
        requestedPath: entry.relativePath ?? entry.path,
        ...(entry.stats !== undefined ? { stats: entry.stats } : {}),
      });
    }
  }

  // Handle fileSearch early
  if (options.fileSearch) {
    const filesMatched: FileMatch[] = filesToScan.map((file) => {
      const size = file.stats?.isFile() === true ? file.stats.size : undefined;
      const modified = file.stats?.mtime;
      return {
        filePath: file.resolvedPath,
        matches: [],
        ...(size !== undefined ? { size } : {}),
        ...(modified !== undefined ? { modified } : {}),
      };
    });
    return {
      filesMatched,
      summary: {
        filesScanned: filesToScan.length,
        filesMatched: filesMatched.length,
        matchesCount: 0,
        truncated: filesToScan.length >= maxFilesScanned,
      },
    };
  }

  // Compile matcher
  const matcherOptions: MatcherOptions = {
    caseSensitive,
    wholeWord,
    isLiteral,
    ...(options.fuzzy !== undefined ? { fuzzy: options.fuzzy } : {}),
  };
  const matcher = buildMatcher(pattern, matcherOptions);

  const filesMatched: FileMatch[] = [];
  let matchesCount = 0;
  let filesScanned = 0;

  // Use worker threads for pattern matching if in production and concurrency is requested
  const shouldUseWorkers = !isSourceContext && SEARCH_WORKERS >= 2;

  if (shouldUseWorkers) {
    const pool = getPool();
    const pending = new Set<ScanTask>();
    const taskToFile = new Map<ScanTask, (typeof filesToScan)[number]>();
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
        const remainingMatches = maxResults - matchesCount;
        if (remainingMatches <= 0) break;

        const task = pool.scan({
          resolvedPath: file.resolvedPath,
          requestedPath: file.requestedPath,
          pattern,
          matcherOptions,
          scanOptions: {
            maxFileSize,
            skipBinary,
            contextBefore: options.contextBefore ?? 0,
            contextAfter: options.contextAfter ?? 0,
          },
          maxMatches: remainingMatches,
        });
        taskToFile.set(task, file);
        pending.add(task);
      }
    };

    fillPool();

    const onAbort = () => {
      for (const task of pending) {
        task.cancel();
      }
    };
    if (options.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      while (pending.size > 0 && matchesCount < maxResults) {
        if (options.signal?.aborted) break;
        filesScanned++;
        const raceCandidates = Array.from(pending).map((task) =>
          task.promise.then(
            (result) => ({ task, result, error: null }),
            (error: unknown) => ({ task, result: null, error }),
          ),
        );

        const winner = await Promise.race(raceCandidates);
        pending.delete(winner.task);
        const file = taskToFile.get(winner.task);
        taskToFile.delete(winner.task);

        if (winner.error === null && winner.result?.matched === true) {
          const size = file?.stats?.isFile() === true ? file.stats.size : undefined;
          const modified = file?.stats?.mtime;
          filesMatched.push({
            filePath: file?.resolvedPath ?? '',
            matches: winner.result.matches,
            ...(size !== undefined ? { size } : {}),
            ...(modified !== undefined ? { modified } : {}),
          });
          matchesCount += winner.result.matches.length;
        }

        fillPool();
      }
    } finally {
      if (options.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
      for (const task of pending) {
        task.cancel();
      }
    }
  } else {
    // Sequential fallback
    for (const file of filesToScan) {
      if (options.signal?.aborted) break;
      if (matchesCount >= maxResults) break;
      filesScanned++;

      try {
        const fileHandle = await fs.open(file.resolvedPath, 'r');
        await using _disposer = fileHandle;
        const stats = await fileHandle.stat();

        if (stats.size > maxFileSize) {
          continue;
        }

        if (skipBinary) {
          // Simple binary check: check first 512 bytes for null byte
          const buffer = Buffer.alloc(512);
          const { bytesRead } = await fileHandle.read(buffer, 0, 512, 0);
          let isBinary = false;
          for (let i = 0; i < bytesRead; i++) {
            if (buffer[i] === 0) {
              isBinary = true;
              break;
            }
          }
          if (isBinary) continue;
        }

        // Read lines and match
        const lines = fileHandle.readLines({ encoding: 'utf-8' });
        const matches: ContentMatch[] = [];

        const contextBefore = options.contextBefore ?? 0;
        const contextAfter = options.contextAfter ?? 0;

        const allLines: string[] = [];
        for await (const line of lines) {
          allLines.push(line);
        }

        for (let i = 0; i < allLines.length; i++) {
          if (matchesCount >= maxResults) break;
          const line = allLines[i];
          if (line !== undefined && matcher.matchCount(line) > 0) {
            const before = allLines.slice(Math.max(0, i - contextBefore), i);
            const after = allLines.slice(i + 1, Math.min(allLines.length, i + 1 + contextAfter));
            matches.push({
              line: i + 1,
              content: line,
              before,
              after,
            });
            matchesCount++;
          }
        }

        if (matches.length > 0) {
          const size = file.stats?.isFile() === true ? file.stats.size : undefined;
          const modified = file.stats?.mtime;
          filesMatched.push({
            filePath: file.resolvedPath,
            matches,
            ...(size !== undefined ? { size } : {}),
            ...(modified !== undefined ? { modified } : {}),
          });
        }
      } catch {
        // Ignore inaccessible files
      }
    }
  }

  return {
    filesMatched,
    summary: {
      filesScanned,
      filesMatched: filesMatched.length,
      matchesCount,
      truncated: matchesCount >= maxResults,
    },
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function getMatcherCacheKey(pattern: string, options: MatcherOptions): string {
  const cs = options.caseSensitive ? '1' : '0';
  const ww = options.wholeWord ? '1' : '0';
  const lit = options.isLiteral ? '1' : '0';
  const fz = options.fuzzy ? '1' : '0';
  return `${pattern}|${cs}|${ww}|${lit}|${fz}`;
}

function getCachedMatcher(pattern: string, options: MatcherOptions): ContentMatcher {
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

function refreshMatcherCacheEntry(key: string, matcher: ContentMatcher): void {
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
  const { id, resolvedPath, pattern, matcherOptions, scanOptions, maxMatches } = request;

  if (consumeCancelled(id)) return;
  activeRequests.add(id);

  try {
    const matcher = getCachedMatcher(pattern, matcherOptions);

    // Read matches and check
    const { open } = await import('node:fs/promises');
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
      let isBinary = false;
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) {
          isBinary = true;
          break;
        }
      }
      if (isBinary) {
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

    const lines = handle.readLines({ encoding: 'utf-8' });
    const matches: ContentMatch[] = [];
    const allLines: string[] = [];
    for await (const line of lines) {
      allLines.push(line);
    }

    for (let i = 0; i < allLines.length; i++) {
      if (matches.length >= maxMatches) break;
      const line = allLines[i];
      if (line !== undefined && matcher.matchCount(line) > 0) {
        const before = allLines.slice(Math.max(0, i - scanOptions.contextBefore), i);
        const after = allLines.slice(
          i + 1,
          Math.min(allLines.length, i + 1 + scanOptions.contextAfter),
        );
        matches.push({
          line: i + 1,
          content: line,
          before,
          after,
        });
      }
    }

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
    if (consumeCancelled(id)) return;
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
