import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

import { listDirectory } from '../src/lib/file-operations/list-directory.js';
import { setAllowedDirectoriesResolved } from '../src/lib/path-validation.js';

const DIR_COUNT = 10;
const FILES_PER_DIR = 20;
const NESTED_FILES = 5;
const WARMUP_RUNS = 5;
const MEASURED_RUNS = 25;

async function createFixture(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const writes: Promise<void>[] = [];

  for (let i = 0; i < DIR_COUNT; i += 1) {
    const dir = path.join(root, `dir-${i}`);
    await fs.mkdir(dir, { recursive: true });
    for (let j = 0; j < FILES_PER_DIR; j += 1) {
      writes.push(
        fs.writeFile(path.join(dir, `file-${j}.txt`), 'fixture-data')
      );
    }
    const nested = path.join(dir, 'nested');
    await fs.mkdir(nested, { recursive: true });
    for (let k = 0; k < NESTED_FILES; k += 1) {
      writes.push(
        fs.writeFile(
          path.join(nested, `nested-${k}.txt`),
          'nested-fixture-data'
        )
      );
    }
  }

  await Promise.all(writes);
}

function computeStats(samples: number[]): {
  mean: number;
  min: number;
  max: number;
  p95: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((sum, value) => sum + value, 0);
  const mean = total / samples.length;
  const p95Index = Math.max(0, Math.ceil(samples.length * 0.95) - 1);
  return {
    mean,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    p95: sorted[p95Index] ?? 0,
  };
}

async function run(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-bench-'));

  try {
    await createFixture(root);
    await setAllowedDirectoriesResolved([root]);

    for (let i = 0; i < WARMUP_RUNS; i += 1) {
      await listDirectory(root, { recursive: true, maxEntries: 5000 });
    }

    const durations: number[] = [];
    const memoryBefore = process.memoryUsage().rss;

    for (let i = 0; i < MEASURED_RUNS; i += 1) {
      const start = performance.now();
      await listDirectory(root, { recursive: true, maxEntries: 5000 });
      durations.push(performance.now() - start);
    }

    const memoryAfter = process.memoryUsage().rss;
    const stats = computeStats(durations);
    const rssDeltaMb = (memoryAfter - memoryBefore) / (1024 * 1024);

    console.log('listDirectory benchmark');
    console.log(
      `runs=${MEASURED_RUNS} mean=${stats.mean.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms`
    );
    console.log(
      `min=${stats.min.toFixed(2)}ms max=${stats.max.toFixed(2)}ms rssΔ=${rssDeltaMb.toFixed(2)}MB`
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('Benchmark failed', error);
  process.exitCode = 1;
});
