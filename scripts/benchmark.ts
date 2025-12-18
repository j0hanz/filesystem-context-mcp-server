#!/usr/bin/env tsx
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

import { searchContent } from '../src/lib/file-operations.js';
import { tailFile } from '../src/lib/fs-helpers.js';
import { normalizePath } from '../src/lib/path-utils.js';
import { setAllowedDirectories } from '../src/lib/path-validation.js';

async function benchmark(
  name: string,
  fn: () => Promise<void>,
  iterations = 5
): Promise<void> {
  const times: number[] = [];

  // Warm-up
  await fn();

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    const duration = performance.now() - start;
    times.push(duration);
  }

  const avg = times.reduce((a, b) => a + b) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const stdDev = Math.sqrt(
    times.reduce((sum, t) => sum + Math.pow(t - avg, 2), 0) / times.length
  );

  console.log(`\n${name}:`);
  console.log(`  Avg: ${avg.toFixed(2)}ms`);
  console.log(`  Min: ${min.toFixed(2)}ms`);
  console.log(`  Max: ${max.toFixed(2)}ms`);
  console.log(`  StdDev: ${stdDev.toFixed(2)}ms`);
}

async function main(): Promise<void> {
  console.log('🚀 Performance Benchmark Suite\n');
  console.log('Creating test fixtures...');

  // Create temporary test directory
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-benchmark-'));
  setAllowedDirectories([normalizePath(tmpDir)]);

  try {
    // Create large test file for tailFile benchmark
    const largeFilePath = path.join(tmpDir, 'large-file.txt');
    const lines: string[] = [];
    for (let i = 0; i < 50000; i++) {
      lines.push(
        `Line ${i}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.`
      );
    }
    await fs.writeFile(largeFilePath, lines.join('\n'));

    // Create many files for search benchmark
    const searchDir = path.join(tmpDir, 'search-test');
    await fs.mkdir(searchDir, { recursive: true });
    for (let i = 0; i < 100; i++) {
      const content = `
// File ${i}
function example${i}() {
  // TODO: Implement this
  console.log("Hello from file ${i}");
  // FIXME: Need to handle edge cases
}
`;
      await fs.writeFile(path.join(searchDir, `file${i}.ts`), content);
    }

    console.log('✅ Fixtures created\n');
    console.log('Running benchmarks...');

    // Benchmark 1: Tail file (UTF-8 boundary optimization)
    await benchmark('Tail 50K-line file (1000 lines)', async () => {
      await tailFile(largeFilePath, 1000);
    });

    // Benchmark 2: Search literal string (indexOf fast-path)
    await benchmark('Search literal "TODO" (100 files)', async () => {
      await searchContent(searchDir, 'TODO', {
        isLiteral: true,
        caseSensitive: false,
        maxResults: 1000,
      });
    });

    // Benchmark 3: Search with regex (baseline comparison)
    await benchmark('Search regex "TODO" (100 files)', async () => {
      await searchContent(searchDir, 'TODO', {
        isLiteral: false,
        caseSensitive: false,
        maxResults: 1000,
      });
    });

    // Benchmark 4: Search with complex pattern
    await benchmark('Search regex "function\\s+\\w+" (100 files)', async () => {
      await searchContent(searchDir, 'function\\s+\\w+', {
        isLiteral: false,
        caseSensitive: false,
        maxResults: 1000,
      });
    });

    console.log('\n✅ Benchmark complete!');
  } finally {
    // Clean up
    console.log('\nCleaning up test fixtures...');
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    console.log('✅ Cleanup complete');
  }
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
