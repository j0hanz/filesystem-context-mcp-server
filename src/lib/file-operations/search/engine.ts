import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { SearchContentResult } from '../../../config/types.js';
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCHABLE_FILE_SIZE,
  SEARCH_WORKERS,
} from '../../constants.js';
import { createTimedAbortSignal } from '../../fs-helpers.js';
import { normalizePath } from '../../path-utils.js';
import {
  getAllowedDirectories,
  isPathWithinDirectories,
  toAccessDeniedWithHint,
  validateExistingDirectory,
  validateExistingPathDetailed,
} from '../../path-validation.js';
import { globEntries } from '../glob-engine.js';
import {
  buildMatcher,
  type MatcherOptions,
  type ScanFileOptions,
  scanFileResolved,
  type ScanFileResult,
} from './scan-file.js';

interface SearchOptions {
  filePattern: string;
  excludePatterns: string[];
  caseSensitive: boolean;
  maxResults: number;
  maxFileSize: number;
  maxFilesScanned: number;
  timeoutMs: number;
  skipBinary: boolean;
  contextLines: number;
  wholeWord: boolean;
  isLiteral: boolean;
  includeHidden: boolean;
  baseNameMatch: boolean;
  caseSensitiveFileMatch: boolean;
}

export interface SearchContentOptions extends Partial<SearchOptions> {
  signal?: AbortSignal;
}

type ResolvedOptions = SearchOptions;

type WorkerScanOptions = ScanFileOptions & MatcherOptions;

interface WorkerScanRequest {
  id: number;
  type: 'scan';
  payload: {
    resolvedPath: string;
    requestedPath: string;
    pattern: string;
    options: WorkerScanOptions;
    maxMatches: number;
  };
}

interface WorkerCancelRequest {
  id: number;
  type: 'cancel';
  reason?: string;
}

interface WorkerScanSuccess {
  id: number;
  ok: true;
  result: ScanFileResult;
}

interface WorkerScanFailure {
  id: number;
  ok: false;
  error: string;
}

type WorkerScanResponse = WorkerScanSuccess | WorkerScanFailure;

interface SearchWorkerClient {
  scan: (
    payload: WorkerScanRequest['payload'],
    signal?: AbortSignal
  ) => Promise<ScanFileResult>;
  close: () => Promise<void>;
}

function isWorkerScanResponse(value: unknown): value is WorkerScanResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { id?: unknown; ok?: unknown };
  return typeof candidate.id === 'number' && typeof candidate.ok === 'boolean';
}

function getAbortError(signal: AbortSignal): Error {
  const { reason } = signal as { reason?: unknown };
  if (reason instanceof Error) {
    return reason;
  }
  return new Error('Operation aborted');
}

function getAbortReason(signal: AbortSignal): string | undefined {
  const { reason } = signal as { reason?: unknown };
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === 'string') {
    return reason;
  }
  return undefined;
}

const DEFAULTS: SearchOptions = {
  filePattern: '**/*',
  excludePatterns: [],
  caseSensitive: false,
  maxResults: DEFAULT_MAX_RESULTS,
  maxFileSize: MAX_SEARCHABLE_FILE_SIZE,
  maxFilesScanned: DEFAULT_SEARCH_MAX_FILES,
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  skipBinary: true,
  contextLines: 0,
  wholeWord: false,
  isLiteral: false,
  includeHidden: false,
  baseNameMatch: false,
  caseSensitiveFileMatch: true,
};

function mergeOptions(partial: SearchContentOptions): ResolvedOptions {
  const { signal, ...rest } = partial;
  void signal; // signal handled externally via createTimedAbortSignal
  const merged: ResolvedOptions = { ...DEFAULTS, ...rest };
  return merged;
}

function buildWorkerOptions(options: ResolvedOptions): WorkerScanOptions {
  return {
    caseSensitive: options.caseSensitive,
    wholeWord: options.wholeWord,
    isLiteral: options.isLiteral,
    maxFileSize: options.maxFileSize,
    skipBinary: options.skipBinary,
    contextLines: options.contextLines,
  };
}

function resolveNonSymlinkPath(
  entryPath: string,
  allowedDirs: string[]
): { resolvedPath: string; requestedPath: string } {
  const normalized = normalizePath(entryPath);
  if (!isPathWithinDirectories(normalized, allowedDirs)) {
    throw toAccessDeniedWithHint(entryPath, normalized, normalized);
  }
  return { resolvedPath: normalized, requestedPath: normalized };
}

function resolveWorkerUrl(): URL {
  const workerJsUrl = new URL('./worker.js', import.meta.url);
  const workerJsPath = fileURLToPath(workerJsUrl);
  if (existsSync(workerJsPath)) {
    return workerJsUrl;
  }

  const workerTsUrl = new URL('./worker.ts', import.meta.url);
  const workerTsPath = fileURLToPath(workerTsUrl);
  if (existsSync(workerTsPath)) {
    return workerTsUrl;
  }

  throw new Error(
    `Search worker entrypoint not found at ${workerJsPath} or ${workerTsPath}`
  );
}

function createSearchWorker(): SearchWorkerClient {
  const worker = new Worker(resolveWorkerUrl());
  let nextId = 1;
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve: (result: ScanFileResult) => void;
      reject: (error: Error) => void;
      signal?: AbortSignal;
      onAbort?: () => void;
    }
  >();

  const cleanupPendingRecord = (record: {
    signal?: AbortSignal;
    onAbort?: () => void;
  }): void => {
    if (record.signal && record.onAbort) {
      record.signal.removeEventListener('abort', record.onAbort);
    }
  };

  const rejectPending = (error: Error): void => {
    for (const record of pending.values()) {
      cleanupPendingRecord(record);
      const { reject } = record;
      reject(error);
    }
    pending.clear();
  };

  worker.on('message', (message: unknown) => {
    if (!isWorkerScanResponse(message)) return;
    const record = pending.get(message.id);
    if (!record) return;
    pending.delete(message.id);
    cleanupPendingRecord(record);
    if (message.ok) {
      record.resolve(message.result);
    } else {
      record.reject(new Error(message.error));
    }
  });

  worker.on('error', (error) => {
    if (closed) return;
    closed = true;
    rejectPending(error);
  });

  worker.on('exit', (code) => {
    if (closed) return;
    closed = true;
    const error = new Error(`Search worker exited with code ${String(code)}`);
    rejectPending(error);
  });

  return {
    scan: async (payload, signal) => {
      if (closed) {
        throw new Error('Search worker is closed');
      }
      if (signal?.aborted) {
        throw getAbortError(signal);
      }
      const id = nextId++;
      return await new Promise<ScanFileResult>((resolve, reject) => {
        let aborted = false;
        const onAbort = (): void => {
          if (aborted) return;
          aborted = true;
          pending.delete(id);
          try {
            const cancelRequest: WorkerCancelRequest = {
              id,
              type: 'cancel',
              reason: signal ? getAbortReason(signal) : undefined,
            };
            worker.postMessage(cancelRequest);
          } catch {
            // Ignore postMessage failures after abort.
          }
          reject(
            signal ? getAbortError(signal) : new Error('Operation aborted')
          );
        };

        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }

        pending.set(id, { resolve, reject, signal, onAbort });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        try {
          worker.postMessage({ id, type: 'scan', payload });
        } catch (error: unknown) {
          pending.delete(id);
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      rejectPending(new Error('Search worker closed'));
      await worker.terminate();
    },
  };
}

export async function searchContent(
  basePath: string,
  pattern: string,
  options: SearchContentOptions = {}
): Promise<SearchContentResult> {
  const opts = mergeOptions(options);
  const { signal, cleanup } = createTimedAbortSignal(
    options.signal,
    opts.timeoutMs
  );
  const root = await validateExistingDirectory(basePath, signal);
  const matcher = buildMatcher(pattern, opts);
  const useWorkers = SEARCH_WORKERS > 0;
  const worker = useWorkers ? createSearchWorker() : undefined;
  const workerOptions = useWorkers ? buildWorkerOptions(opts) : undefined;
  const allowedDirs = getAllowedDirectories();

  let filesScanned = 0;
  let filesMatched = 0;
  let skippedTooLarge = 0;
  let skippedBinary = 0;
  let skippedInaccessible = 0;
  const linesSkippedDueToRegexTimeout = 0;
  let truncated = false;
  let stoppedReason: SearchContentResult['summary']['stoppedReason'];

  const matches: SearchContentResult['matches'][number][] = [];

  try {
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

    for await (const entry of stream) {
      if (!entry.dirent.isFile()) continue;
      if (signal.aborted) {
        truncated = true;
        stoppedReason = 'timeout';
        break;
      }
      if (filesScanned >= opts.maxFilesScanned) {
        truncated = true;
        stoppedReason = 'maxFiles';
        break;
      }
      filesScanned++;
      const remaining = opts.maxResults - matches.length;
      if (remaining <= 0) {
        truncated = true;
        stoppedReason = 'maxResults';
        break;
      }

      try {
        const { resolvedPath, requestedPath } = entry.dirent.isSymbolicLink()
          ? await validateExistingPathDetailed(entry.path, signal)
          : resolveNonSymlinkPath(entry.path, allowedDirs);
        const scanResult = worker
          ? await worker.scan(
              {
                resolvedPath,
                requestedPath,
                pattern,
                options: workerOptions ?? buildWorkerOptions(opts),
                maxMatches: remaining,
              },
              signal
            )
          : await scanFileResolved(
              resolvedPath,
              requestedPath,
              matcher,
              opts,
              signal,
              remaining
            );

        if (scanResult.skippedTooLarge) {
          skippedTooLarge++;
        }
        if (scanResult.skippedBinary) {
          skippedBinary++;
        }
        if (scanResult.matched) {
          filesMatched++;
        }
        if (scanResult.matches.length > 0) {
          matches.push(...scanResult.matches);
        }
      } catch {
        skippedInaccessible++;
      }

      if (matches.length >= opts.maxResults) {
        truncated = true;
        stoppedReason = 'maxResults';
        break;
      }
    }

    return {
      basePath: root,
      pattern,
      filePattern: opts.filePattern,
      matches,
      summary: {
        filesScanned,
        filesMatched,
        matches: matches.length,
        truncated,
        skippedTooLarge,
        skippedBinary,
        skippedInaccessible,
        linesSkippedDueToRegexTimeout,
        stoppedReason,
      },
    };
  } finally {
    if (worker) {
      await worker.close().catch(() => undefined);
    }
    cleanup();
  }
}
