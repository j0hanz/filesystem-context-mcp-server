import { SearchWorkerPool } from './worker-pool.js';

// Singleton pool instance
let poolInstance: SearchWorkerPool | null = null;
let poolSize = 0;

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
