import type { Worker } from 'node:worker_threads';

import type { WorkerResponse } from './search-worker.js';
import type { WorkerSlot } from './worker-pool-types.js';

type LogFn = (message: string) => void;

export function handleWorkerMessage(
  slot: WorkerSlot,
  message: WorkerResponse,
  log: LogFn
): void {
  const pending = slot.pending.get(message.id);
  if (!pending) {
    log(`Received message for unknown request ${String(message.id)}`);
    return;
  }

  slot.pending.delete(message.id);

  if (message.type === 'result') {
    pending.resolve(message.result);
  } else {
    pending.reject(new Error(message.error));
  }
}

export function handleWorkerError(
  slot: WorkerSlot,
  error: Error,
  log: LogFn
): void {
  log(`Worker ${String(slot.index)} error: ${error.message}`);

  for (const [, pending] of slot.pending) {
    pending.reject(new Error(`Worker error: ${error.message}`));
  }
  slot.pending.clear();

  slot.worker?.terminate().catch(() => {});
  slot.worker = null;
}

export function handleWorkerExit(
  slot: WorkerSlot,
  code: number,
  isClosed: boolean,
  maxRespawns: number,
  log: LogFn
): void {
  log(`Worker ${String(slot.index)} exited with code ${String(code)}`);

  if (isClosed) {
    return;
  }

  if (slot.pending.size > 0) {
    const error = new Error(
      `Worker exited unexpectedly with code ${String(code)}`
    );
    for (const [, pending] of slot.pending) {
      pending.reject(error);
    }
    slot.pending.clear();
  }

  slot.worker = null;

  if (code !== 0 && slot.respawnCount < maxRespawns) {
    slot.respawnCount++;
    log(
      `Worker ${String(slot.index)} will be respawned on next request (attempt ${String(slot.respawnCount)}/${String(maxRespawns)})`
    );
  } else if (slot.respawnCount >= maxRespawns) {
    log(`Worker ${String(slot.index)} exceeded max respawns, slot disabled`);
  }
}

export function selectSlot(
  slots: WorkerSlot[],
  nextSlotIndex: number,
  maxRespawns: number
): { slot: WorkerSlot | null; nextSlotIndex: number } {
  let attempts = 0;
  let index = nextSlotIndex;

  while (attempts < slots.length) {
    const slot = slots[index];
    index = (index + 1) % slots.length;
    attempts++;

    if (slot && (slot.worker || slot.respawnCount < maxRespawns)) {
      return { slot, nextSlotIndex: index };
    }
  }

  return { slot: null, nextSlotIndex: index };
}

export function attachWorkerHandlers(
  worker: Worker,
  slot: WorkerSlot,
  getClosed: () => boolean,
  maxRespawns: number,
  log: LogFn
): void {
  worker.on('message', (message: WorkerResponse) => {
    handleWorkerMessage(slot, message, log);
  });

  worker.on('error', (error: Error) => {
    handleWorkerError(slot, error, log);
  });

  worker.on('exit', (code: number) => {
    handleWorkerExit(slot, code, getClosed(), maxRespawns, log);
  });
}
