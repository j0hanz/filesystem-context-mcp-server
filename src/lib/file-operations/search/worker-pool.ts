import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { ScanRequest } from './search-worker.js';
import { attachWorkerHandlers, selectSlot } from './worker-pool-helpers.js';
import type {
  PoolOptions,
  ScanTask,
  WorkerScanRequest,
  WorkerScanResult,
  WorkerSlot,
} from './worker-pool-types.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// Support both source (.ts via tsx) and compiled (.js) contexts
const currentFile = fileURLToPath(import.meta.url);
const isSourceContext = currentFile.endsWith('.ts');
const WORKER_SCRIPT_PATH = path.join(
  currentDir,
  isSourceContext ? 'search-worker.ts' : 'search-worker.js'
);

// Maximum respawns per worker slot before giving up
const MAX_RESPAWNS = 3;

export class SearchWorkerPool {
  private readonly slots: WorkerSlot[];
  private readonly debug: boolean;
  private nextRequestId = 0;
  private nextSlotIndex = 0;
  private closed = false;

  constructor(options: PoolOptions) {
    this.debug = options.debug ?? false;
    this.slots = [];

    for (let i = 0; i < options.size; i++) {
      this.slots.push({
        worker: null,
        pending: new Map(),
        respawnCount: 0,
        index: i,
      });
    }
  }

  private log(message: string): void {
    if (this.debug) {
      console.error(`[SearchWorkerPool] ${message}`);
    }
  }

  private spawnWorker(slot: WorkerSlot): Worker {
    this.log(`Spawning worker for slot ${String(slot.index)}`);
    const workerOptions = {
      workerData: {
        debug: this.debug,
        threadId: slot.index,
      },
      execArgv: isSourceContext ? ['--import', 'tsx'] : undefined,
    };

    const worker = new Worker(WORKER_SCRIPT_PATH, workerOptions);

    // Unref so worker doesn't keep process alive
    worker.unref();
    const logEntry = (entry: string): void => {
      this.log(entry);
    };
    attachWorkerHandlers(
      worker,
      slot,
      () => this.closed,
      MAX_RESPAWNS,
      logEntry
    );

    return worker;
  }

  private getWorker(slot: WorkerSlot): Worker {
    slot.worker ??= this.spawnWorker(slot);
    return slot.worker;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('Worker pool is closed');
    }
  }

  private selectAvailableSlot(): WorkerSlot {
    const selection = selectSlot(this.slots, this.nextSlotIndex, MAX_RESPAWNS);
    this.nextSlotIndex = selection.nextSlotIndex;
    if (!selection.slot) {
      throw new Error('All worker slots are disabled');
    }
    return selection.slot;
  }

  private buildScanRequest(
    id: number,
    request: WorkerScanRequest
  ): ScanRequest {
    return {
      type: 'scan',
      id,
      ...request,
    };
  }

  private createScanPromise(
    slot: WorkerSlot,
    worker: Worker,
    scanRequest: ScanRequest
  ): Promise<WorkerScanResult> {
    let settled = false;
    return new Promise<WorkerScanResult>((resolve, reject) => {
      const safeResolve = (result: WorkerScanResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const safeReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      slot.pending.set(scanRequest.id, {
        resolve: safeResolve,
        reject: safeReject,
        request: scanRequest,
      });

      worker.postMessage(scanRequest);
    });
  }

  private createCancel(
    slot: WorkerSlot,
    worker: Worker,
    id: number
  ): () => void {
    return (): void => {
      const pending = slot.pending.get(id);
      if (!pending) return;
      slot.pending.delete(id);
      worker.postMessage({ type: 'cancel', id });
      pending.reject(new Error('Scan cancelled'));
    };
  }

  /**
   * Scan a file for content matches using a worker thread.
   */
  scan(request: WorkerScanRequest): ScanTask {
    this.ensureOpen();
    const slot = this.selectAvailableSlot();
    const worker = this.getWorker(slot);
    const id = this.nextRequestId++;
    const scanRequest = this.buildScanRequest(id, request);
    const promise = this.createScanPromise(slot, worker, scanRequest);
    const cancel = this.createCancel(slot, worker, id);
    return { id, promise, cancel };
  }

  /**
   * Close the pool and terminate all workers.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.log('Closing worker pool');

    // Cancel all pending requests
    for (const slot of this.slots) {
      for (const [, pending] of slot.pending) {
        pending.reject(new Error('Worker pool closed'));
      }
      slot.pending.clear();
    }

    // Terminate all workers
    const terminatePromises: Promise<number>[] = [];
    for (const slot of this.slots) {
      if (slot.worker) {
        slot.worker.postMessage({ type: 'shutdown' });
        terminatePromises.push(slot.worker.terminate());
        slot.worker = null;
      }
    }

    await Promise.allSettled(terminatePromises);
    this.log('Worker pool closed');
  }
}

export function isWorkerPoolAvailable(): boolean {
  return !isSourceContext;
}

export type { ScanTask, WorkerScanResult } from './worker-pool-types.js';
