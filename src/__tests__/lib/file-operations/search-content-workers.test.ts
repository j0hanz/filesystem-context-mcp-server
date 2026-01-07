/**
 * Tests for worker threads search functionality.
 *
 * These tests run in a child process with FILESYSTEM_CONTEXT_SEARCH_WORKERS
 * enabled to test the worker pool implementation.
 *
 * NOTE: These tests are skipped in source context (tsx) because worker threads
 * don't work properly with tsx's module resolution. They run against compiled
 * code in the dist/ directory.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const currentFile = fileURLToPath(import.meta.url);
const isSourceContext = currentFile.endsWith('.ts');

// Worker tests only work with compiled code
const shouldSkip = isSourceContext;

// Create a test script that will run searchContent with workers enabled
// Uses compiled code paths for proper module resolution
const testScript = `
import { searchContent } from './dist/lib/file-operations/search/engine.js';
import { setAllowedDirectoriesResolved } from './dist/lib/path-validation.js';

async function main() {
  const testDir = process.argv[2];
  const pattern = process.argv[3] || 'hello';

  await setAllowedDirectoriesResolved([testDir]);

  try {
    const result = await searchContent(testDir, pattern);
    console.log(JSON.stringify({
      success: true,
      matches: result.matches.length,
      filesScanned: result.summary.filesScanned,
      filesMatched: result.summary.filesMatched,
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  }
}

main();
`;

interface TestResult {
  success: boolean;
  matches?: number;
  filesScanned?: number;
  filesMatched?: number;
  error?: string;
}

async function runSearchWithWorkers(
  testDir: string,
  pattern: string,
  workers: number
): Promise<TestResult> {
  // Get project root (3 levels up from __tests__/lib/file-operations)
  const projectRoot = path.resolve(currentDir, '..', '..', '..', '..');

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--eval', testScript, testDir, pattern],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          FILESYSTEM_CONTEXT_SEARCH_WORKERS: String(workers),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code: number | null) => {
      // Try to parse the JSON output
      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];

      try {
        const result = JSON.parse(lastLine ?? '{}') as TestResult;
        resolve(result);
      } catch {
        if (code !== 0) {
          reject(
            new Error(`Process exited with code ${String(code)}: ${stderr}`)
          );
        } else {
          resolve({ success: false, error: 'Failed to parse output' });
        }
      }
    });

    child.on('error', reject);
  });
}

void describe(
  'searchContent with worker threads',
  { skip: shouldSkip ? 'Worker tests require compiled code' : false },
  () => {
    let testDir: string;

    before(async () => {
      // Create a temporary test directory with multiple files
      testDir = path.join(currentDir, 'worker-test-fixtures');
      await fs.mkdir(testDir, { recursive: true });

      // Create test files with searchable content
      for (let i = 0; i < 30; i++) {
        const content =
          i % 2 === 0
            ? `File ${String(i)}\nThis file contains hello world\nEnd of file`
            : `File ${String(i)}\nThis file has different content\nEnd of file`;
        await fs.writeFile(
          path.join(testDir, `test-${String(i)}.txt`),
          content
        );
      }
    });

    after(async () => {
      // Clean up test directory
      await fs.rm(testDir, { recursive: true, force: true });
    });

    void it('should work with workers disabled (baseline)', async () => {
      const result = await runSearchWithWorkers(testDir, 'hello', 0);

      assert.strictEqual(
        result.success,
        true,
        `Expected success but got error: ${result.error ?? 'unknown'}`
      );
      assert.ok(
        result.matches !== undefined && result.matches > 0,
        'Should find matches'
      );
      assert.strictEqual(
        result.filesMatched,
        15,
        'Should match 15 files (every other file)'
      );
    });

    void it('should work with 1 worker thread', async () => {
      const result = await runSearchWithWorkers(testDir, 'hello', 1);

      assert.strictEqual(
        result.success,
        true,
        `Expected success but got error: ${result.error ?? 'unknown'}`
      );
      assert.ok(
        result.matches !== undefined && result.matches > 0,
        'Should find matches'
      );
      assert.strictEqual(
        result.filesMatched,
        15,
        'Should match 15 files (every other file)'
      );
    });

    void it('should work with 2 worker threads', async () => {
      const result = await runSearchWithWorkers(testDir, 'hello', 2);

      assert.strictEqual(
        result.success,
        true,
        `Expected success but got error: ${result.error ?? 'unknown'}`
      );
      assert.ok(
        result.matches !== undefined && result.matches > 0,
        'Should find matches'
      );
      assert.strictEqual(
        result.filesMatched,
        15,
        'Should match 15 files (every other file)'
      );
    });

    void it('should return consistent results with and without workers', async () => {
      const resultNoWorkers = await runSearchWithWorkers(testDir, 'file', 0);
      const resultWithWorkers = await runSearchWithWorkers(testDir, 'file', 2);

      assert.strictEqual(resultNoWorkers.success, true);
      assert.strictEqual(resultWithWorkers.success, true);

      // Both should find all 30 files (every file has "File" or "file")
      assert.strictEqual(
        resultNoWorkers.filesScanned,
        resultWithWorkers.filesScanned
      );
      assert.strictEqual(
        resultNoWorkers.filesMatched,
        resultWithWorkers.filesMatched
      );
      // Match counts should be equal
      assert.strictEqual(resultNoWorkers.matches, resultWithWorkers.matches);
    });

    void it('should handle pattern that matches no files', async () => {
      const result = await runSearchWithWorkers(
        testDir,
        'nonexistent-pattern-xyz',
        1
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.matches, 0);
      assert.strictEqual(result.filesMatched, 0);
    });
  }
);
