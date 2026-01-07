import type { Worker } from 'node:worker_threads';

import type { ContentMatch } from '../../../config/types.js';
import type { MatcherOptions, ScanFileOptions } from './scan-file.js';
import type { ScanRequest, ScanResult } from './search-worker.js';

export interface PendingTask {
  resolve: (result: ScanResult['result']) => void;
  reject: (error: Error) => void;
  request: ScanRequest;
}

export interface WorkerSlot {
  worker: Worker | null;
  pending: Map<number, PendingTask>;
  respawnCount: number;
  index: number;
}

export interface PoolOptions {
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

export interface ScanTask {
  id: number;
  promise: Promise<WorkerScanResult>;
  cancel: () => void;
}
