import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Test that the experimental.tasks adapter is properly defined and centralized.
// These tests verify:
// 1. The ExperimentalTasksApi interface exists
// 2. The getExperimentalTasks helper is defined
// 3. The cast is isolated and not repeated inline in the file

describe('experimental.tasks adapter', () => {
  it('should define ExperimentalTasksApi interface with registerToolTask method', () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const defineToolPath = join(__dirname, '../../src/tools/define.ts');
    const content = readFileSync(defineToolPath, 'utf-8');

    // Verify the interface definition exists
    assert.match(
      content,
      /interface ExperimentalTasksApi\s*\{\s*registerToolTask\s*\(\s*name:\s*string,\s*def:\s*unknown,\s*handler:\s*unknown\s*\):\s*void;\s*\}/,
      'ExperimentalTasksApi interface should be defined with registerToolTask method',
    );
  });

  it('should define getExperimentalTasks helper function', () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const defineToolPath = join(__dirname, '../../src/tools/define.ts');
    const content = readFileSync(defineToolPath, 'utf-8');

    // Verify the helper function is defined
    assert.match(
      content,
      /function getExperimentalTasks\s*\(\s*server:\s*McpServer\s*\):\s*ExperimentalTasksApi\s*\{/,
      'getExperimentalTasks function should be defined',
    );
  });

  it('should isolate the cast in getExperimentalTasks and not inline elsewhere', () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const defineToolPath = join(__dirname, '../../src/tools/define.ts');
    const content = readFileSync(defineToolPath, 'utf-8');

    // Count occurrences of the experimental.tasks cast pattern (inline casts as type guard)
    const inlinecastMatches = (content.match(/experimental\.tasks\s+as\s+unknown\s+as\s*\{/g) ?? [])
      .length;

    assert.strictEqual(
      inlinecastMatches,
      0,
      'No inline casts of experimental.tasks should remain outside of getExperimentalTasks',
    );

    // Verify the cast exists inside getExperimentalTasks by looking for the assignment
    const hasHelperCast =
      /const\s+typedTasks\s*=\s*server\.experimental\.tasks\s+as\s+unknown\s+as\s+ExperimentalTasksApi/.test(
        content,
      );
    assert.ok(hasHelperCast, 'Cast should be isolated inside getExperimentalTasks helper');
  });

  it('should use getExperimentalTasks at the call site', () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const defineToolPath = join(__dirname, '../../src/tools/define.ts');
    const content = readFileSync(defineToolPath, 'utf-8');

    // Verify getExperimentalTasks is called with deps.server
    assert.match(
      content,
      /getExperimentalTasks\s*\(\s*deps\.server\s*\)\s*\.registerToolTask/,
      'getExperimentalTasks should be called with deps.server and registerToolTask invoked',
    );
  });

  it('should have appropriate documentation comment', () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const defineToolPath = join(__dirname, '../../src/tools/define.ts');
    const content = readFileSync(defineToolPath, 'utf-8');

    // Verify there's a comment explaining why this is a workaround
    assert.match(
      content,
      /\/\/\s+Local\s+type\s+adapter\s+for\s+experimental\.tasks[\s\S]*?Delete\s+once\s+the\s+SDK/,
      'Should have documentation explaining this is a temporary workaround',
    );
  });
});
