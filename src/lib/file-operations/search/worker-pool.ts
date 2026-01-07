/**
 * Worker pool for parallel file content searching.
 *
 * Manages a pool of worker threads that can process file scanning requests
 * in parallel. Uses round-robin distribution with self-healing capabilities.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { ContentMatch } from '../../../config/types.js';
import type { MatcherOptions, ScanFileOptions } from './scan-file.js';
import type {
  ScanRequest,
  ScanResult,
  WorkerResponse,
} from './search-worker.js';

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

interface PendingTask {
  resolve: (result: ScanResult['result']) => void;
  reject: (error: Error) => void;
  request: ScanRequest;
}

interface WorkerSlot {
  worker: Worker | null;
  pending: Map<number, PendingTask>;
  respawnCount: number;
  index: number;
}

interface PoolOptions {
  size: number;
  debug?: boolean;
}

export interface WorkerScanRequest {
  resolvedPath: string;
  requestedPath: string;
  pattern: string;
  matcherOptions: MatcherOptions;
  scanOptions: ScanFileOptions;
  maxMatches: number;
}

export interface WorkerScanResult {
  matches: readonly ContentMatch[];
  matched: boolean;
  skippedTooLarge: boolean;
  skippedBinary: boolean;
}

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

    // For TypeScript source files, we need tsx loader
    // Note: tsx/esm doesn't fully work in worker threads for .js -> .ts resolution
    // Using tsx directly with ts-node style registration
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

    worker.on('message', (message: WorkerResponse) => {
      this.handleWorkerMessage(slot, message);
    });

    worker.on('error', (error: Error) => {
      this.handleWorkerError(slot, error);
    });

    worker.on('exit', (code: number) => {
      this.handleWorkerExit(slot, code);
    });

    return worker;
  }

  private getWorker(slot: WorkerSlot): Worker {
    slot.worker ??= this.spawnWorker(slot);
    return slot.worker;
  }

  private handleWorkerMessage(slot: WorkerSlot, message: WorkerResponse): void {
    const pending = slot.pending.get(message.id);
    if (!pending) {
      this.log(`Received message for unknown request ${String(message.id)}`);
      return;
    }

    slot.pending.delete(message.id);

    if (message.type === 'result') {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error));
    }
  }

  private handleWorkerError(slot: WorkerSlot, error: Error): void {
    this.log(`Worker ${String(slot.index)} error: ${error.message}`);

    // Reject all pending tasks
    for (const [, pending] of slot.pending) {
      pending.reject(new Error(`Worker error: ${error.message}`));
    }
    slot.pending.clear();

    // Terminate the worker
    slot.worker?.terminate().catch(() => {});
    slot.worker = null;
  }

  private handleWorkerExit(slot: WorkerSlot, code: number): void {
    this.log(`Worker ${String(slot.index)} exited with code ${String(code)}`);

    // If pool is closed, don't respawn
    if (this.closed) {
      return;
    }

    // Reject pending tasks if there are any
    if (slot.pending.size > 0) {
      const error = new Error(
        `Worker exited unexpectedly with code ${String(code)}`
      );
      for (const [, pending] of slot.pending) {
        pending.reject(error);
      }
      slot.pending.clear();
    }

    // Clear worker reference
    slot.worker = null;

    // Attempt respawn on next request (lazy respawn)
    if (code !== 0 && slot.respawnCount < MAX_RESPAWNS) {
      slot.respawnCount++;
      this.log(
        `Worker ${String(slot.index)} will be respawned on next request (attempt ${String(slot.respawnCount)}/${String(MAX_RESPAWNS)})`
      );
    } else if (slot.respawnCount >= MAX_RESPAWNS) {
      this.log(
        `Worker ${String(slot.index)} exceeded max respawns, slot disabled`
      );
    }
  }

  private selectSlot(): WorkerSlot | null {
    // Round-robin selection, skipping disabled slots
    let attempts = 0;

    while (attempts < this.slots.length) {
      const slot = this.slots[this.nextSlotIndex];
      this.nextSlotIndex = (this.nextSlotIndex + 1) % this.slots.length;
      attempts++;

      // Skip slots that have exceeded respawn limit and have no worker
      if (slot && (slot.worker || slot.respawnCount < MAX_RESPAWNS)) {
        return slot;
      }
    }

    // All slots disabled
    return null;
  }

  /**
   * Scan a file for content matches using a worker thread.
   */
  async scan(request: WorkerScanRequest): Promise<WorkerScanResult> {
    if (this.closed) {
      throw new Error('Worker pool is closed');
    }

    const slot = this.selectSlot();
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

// Singleton pool instance
let poolInstance: SearchWorkerPool | null = null;
let poolSize = 0;

/**
 * Get or create a search worker pool.
 *
 * The pool is lazily initialized on first call and reused across subsequent calls.
 * If the requested size differs from the current pool size, the pool is recreated.
 *
 * @param size Number of workers in the pool
 * @param debug Enable debug logging
 */
export function getSearchWorkerPool(
  size: number,
  debug = false
): SearchWorkerPool {
  if (size <= 0) {
    throw new Error('Pool size must be positive');
  }

  // Reuse existing pool if size matches
  if (poolInstance && poolSize === size) {
    return poolInstance;
  }

  // Close existing pool if size changed
  if (poolInstance) {
    void poolInstance.close();
  }

  poolInstance = new SearchWorkerPool({ size, debug });
  poolSize = size;

  return poolInstance;
}

/**
 * Close the global pool instance if it exists.
 */
export async function closeSearchWorkerPool(): Promise<void> {
  if (poolInstance) {
    await poolInstance.close();
    poolInstance = null;
    poolSize = 0;
  }
}

/**
 * Check if worker pool is available (compiled context, not source).
 * Worker threads don't work properly with tsx in source context
 * due to module resolution issues with .js extension mapping.
 */
export function isWorkerPoolAvailable(): boolean {
  return !isSourceContext;
}
