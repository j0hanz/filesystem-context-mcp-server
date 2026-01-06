import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { WorkerScanOptions } from './options.js';
import type { ScanFileResult } from './scan-file.js';

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
export interface SearchWorkerClient {
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

export function createSearchWorker(): SearchWorkerClient {
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
