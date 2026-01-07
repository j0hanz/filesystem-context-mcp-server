import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const isSourceContext = fileURLToPath(import.meta.url).endsWith('.ts');
const shouldSkip = isSourceContext;

// Create a test script that will run searchContent with workers enabled
// Uses compiled code paths for proper module resolution
const testScript = `
import { searchContent } from './dist/lib/file-operations/search/engine.js';
import { setAllowedDirectoriesResolved } from './dist/lib/path-validation/allowed-directories.js';

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

async function expectHelloMatches(
  testDir: string,
  workers: number
): Promise<void> {
  const result = await runSearchWithWorkers(testDir, 'hello', workers);

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
}

async function runSearchWithWorkers(
  testDir: string,
  pattern: string,
  workers: number
): Promise<TestResult> {
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
      testDir = path.join(currentDir, 'worker-test-fixtures');
      await fs.mkdir(testDir, { recursive: true });

      const fixtures = Array.from({ length: 30 }, (_, index) => {
        const content =
          index % 2 === 0
            ? `File ${String(index)}\nThis file contains hello world\nEnd of file`
            : `File ${String(index)}\nThis file has different content\nEnd of file`;
        return {
          filePath: path.join(testDir, `test-${String(index)}.txt`),
          content,
        };
      });

      await Promise.all(
        fixtures.map((fixture) =>
          fs.writeFile(fixture.filePath, fixture.content)
        )
      );
    });

    after(async () => {
      await fs.rm(testDir, { recursive: true, force: true });
    });

    [
      { label: 'workers disabled (baseline)', workers: 0 },
      { label: '1 worker thread', workers: 1 },
      { label: '2 worker threads', workers: 2 },
    ].forEach(({ label, workers }) => {
      void it(`should work with ${label}`, async () => {
        await expectHelloMatches(testDir, workers);
      });
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
