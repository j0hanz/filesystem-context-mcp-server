import * as path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

import {
  analyzeDirectory,
  getDirectoryTree,
  listDirectory,
  readFile,
  searchContent,
  searchFiles,
} from '../src/lib/file-operations.js';
import { setAllowedDirectories } from '../src/lib/path-validation.js';

interface BenchmarkResult {
  name: string;
  avgMs: number;
  p95Ms: number;
  memDeltaMb: number;
}

async function createFixture(): Promise<{ root: string; sampleFile: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'fs-mcp-bench-'));
  const folders = ['alpha', 'beta', 'gamma', 'alpha/nested', 'beta/logs'];

  await Promise.all(
    folders.map((folder) => mkdir(path.join(root, folder), { recursive: true }))
  );

  const baseContent = [
    'lorem ipsum dolor sit amet',
    'consectetur adipiscing elit',
    'sed do eiusmod tempor incididunt',
    'ut labore et dolore magna aliqua',
  ].join('\n');

  const writeOps: Promise<void>[] = [];
  let sampleFile = '';

  for (let i = 0; i < 120; i++) {
    const folder = i % 3 === 0 ? 'alpha' : i % 3 === 1 ? 'beta' : 'gamma';
    const filePath = path.join(root, folder, `file-${i}.txt`);
    const content = `${baseContent}\nitem:${i}\n${baseContent}`;
    writeOps.push(writeFile(filePath, content, 'utf-8'));
    if (i === 0) {
      sampleFile = filePath;
    }
  }

  await Promise.all(writeOps);

  return { root, sampleFile };
}

async function measure(
  name: string,
  iterations: number,
  fn: () => Promise<void>
): Promise<BenchmarkResult> {
  const samples: number[] = [];
  let memDeltaTotal = 0;

  for (let i = 0; i < iterations; i++) {
    const beforeMem = process.memoryUsage().heapUsed;
    const start = performance.now();
    await fn();
    const end = performance.now();
    const afterMem = process.memoryUsage().heapUsed;
    samples.push(end - start);
    memDeltaTotal += afterMem - beforeMem;
  }

  const avgMs = samples.reduce((sum, v) => sum + v, 0) / samples.length;
  const p95Ms = percentile(samples, 95);
  const memDeltaMb = memDeltaTotal / iterations / (1024 * 1024);

  return {
    name,
    avgMs,
    p95Ms,
    memDeltaMb,
  };
}

function percentile(samples: number[], target: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((target / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

async function runBenchmarks(): Promise<BenchmarkResult[]> {
  const { root, sampleFile } = await createFixture();
  setAllowedDirectories([root]);

  try {
    const iterations = 5;
    const results: BenchmarkResult[] = [];

    results.push(
      await measure('listDirectory(recursive)', iterations, async () => {
        await listDirectory(root, { recursive: true, maxDepth: 3 });
      })
    );

    results.push(
      await measure('searchFiles(**/*.txt)', iterations, async () => {
        await searchFiles(root, '**/*.txt', ['**/logs/**'], {
          maxResults: 200,
        });
      })
    );

    results.push(
      await measure('searchContent(lorem)', iterations, async () => {
        await searchContent(root, 'lorem', {
          filePattern: '**/*.txt',
          maxResults: 200,
          contextLines: 1,
        });
      })
    );

    results.push(
      await measure('getDirectoryTree', iterations, async () => {
        await getDirectoryTree(root, { maxDepth: 3, maxFiles: 500 });
      })
    );

    results.push(
      await measure('analyzeDirectory', iterations, async () => {
        await analyzeDirectory(root, { maxDepth: 3, topN: 5 });
      })
    );

    results.push(
      await measure('readFile(head)', iterations, async () => {
        await readFile(sampleFile, { head: 10 });
      })
    );

    return results;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function renderTable(results: BenchmarkResult[]): void {
  console.log('| Benchmark | Avg ms | P95 ms | Mem Delta (MB) |');
  console.log('| --- | ---: | ---: | ---: |');
  for (const result of results) {
    console.log(
      `| ${result.name} | ${result.avgMs.toFixed(2)} | ${result.p95Ms.toFixed(2)} | ${result.memDeltaMb.toFixed(2)} |`
    );
  }
}

async function main(): Promise<void> {
  const results = await runBenchmarks();
  renderTable(results);
  console.log('\nJSON:', JSON.stringify(results, null, 2));
}

await main();
