import { parentPort } from 'node:worker_threads';

import {
  buildMatcher,
  type MatcherOptions,
  type ScanFileOptions,
  scanFileResolved,
  type ScanFileResult,
} from './scan-file.js';

const port = parentPort;

if (!port) {
  throw new Error('Search worker must be run in a worker thread');
}

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

interface WorkerScanResponse {
  id: number;
  ok: boolean;
  result?: ScanFileResult;
  error?: string;
}

function isWorkerScanRequest(value: unknown): value is WorkerScanRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as {
    id?: unknown;
    type?: unknown;
    payload?: unknown;
  };
  return (
    typeof candidate.id === 'number' &&
    candidate.type === 'scan' &&
    typeof candidate.payload === 'object' &&
    candidate.payload !== null
  );
}

function isWorkerCancelRequest(value: unknown): value is WorkerCancelRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as {
    id?: unknown;
    type?: unknown;
  };
  return typeof candidate.id === 'number' && candidate.type === 'cancel';
}

const activeScans = new Map<number, AbortController>();

port.on('message', async (message: unknown) => {
  if (isWorkerCancelRequest(message)) {
    const controller = activeScans.get(message.id);
    if (!controller) return;
    if (message.reason) {
      controller.abort(new Error(message.reason));
    } else {
      controller.abort();
    }
    return;
  }
  if (!isWorkerScanRequest(message)) return;
  const { id, payload } = message;
  const controller = new AbortController();
  activeScans.set(id, controller);

  try {
    const matcher = buildMatcher(payload.pattern, payload.options);
    const result = await scanFileResolved(
      payload.resolvedPath,
      payload.requestedPath,
      matcher,
      payload.options,
      controller.signal,
      payload.maxMatches
    );
    const response: WorkerScanResponse = { id, ok: true, result };
    port.postMessage(response);
  } catch (error: unknown) {
    const response: WorkerScanResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    port.postMessage(response);
  } finally {
    activeScans.delete(id);
  }
});
