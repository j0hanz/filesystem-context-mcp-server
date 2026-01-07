import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { ScanRequest } from './search-worker.js';
import { attachWorkerHandlers, selectSlot } from './worker-pool-helpers.js';
import type {
  PoolOptions,
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

  /**
   * Scan a file for content matches using a worker thread.
   */
  async scan(request: WorkerScanRequest): Promise<WorkerScanResult> {
    if (this.closed) {
      throw new Error('Worker pool is closed');
    }

    const selection = selectSlot(this.slots, this.nextSlotIndex, MAX_RESPAWNS);
    const { nextSlotIndex, slot } = selection;
    this.nextSlotIndex = nextSlotIndex;
    if (!slot) {
      throw new Error('All worker slots are disabled');
    }

    const worker = this.getWorker(slot);
    const id = this.nextRequestId++;

    const scanRequest: ScanRequest = {
      type: 'scan',
      id,
      ...request,
    };

    return new Promise<WorkerScanResult>((resolve, reject) => {
      slot.pending.set(id, {
        resolve,
        reject,
        request: scanRequest,
      });

      worker.postMessage(scanRequest);
    });
  }

  /**
   * Cancel a pending scan request.
   */
  cancel(requestId: number): void {
    for (const slot of this.slots) {
      if (slot.pending.has(requestId) && slot.worker) {
        slot.worker.postMessage({ type: 'cancel', id: requestId });
        break;
      }
    }
  }

  /**
   * Cancel all pending requests.
   */
  cancelAll(): void {
    for (const slot of this.slots) {
      for (const [id] of slot.pending) {
        if (slot.worker) {
          slot.worker.postMessage({ type: 'cancel', id });
        }
      }
    }
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

  /**
   * Get pool statistics.
   */
  getStats(): {
    size: number;
    activeWorkers: number;
    pendingTasks: number;
    disabledSlots: number;
  } {
    let activeWorkers = 0;
    let pendingTasks = 0;
    let disabledSlots = 0;

    for (const slot of this.slots) {
      if (slot.worker) activeWorkers++;
      pendingTasks += slot.pending.size;
      if (!slot.worker && slot.respawnCount >= MAX_RESPAWNS) disabledSlots++;
    }

    return {
      size: this.slots.length,
      activeWorkers,
      pendingTasks,
      disabledSlots,
    };
  }
}

export function isWorkerPoolAvailable(): boolean {
  return !isSourceContext;
}

export type {
  WorkerScanRequest,
  WorkerScanResult,
} from './worker-pool-types.js';
