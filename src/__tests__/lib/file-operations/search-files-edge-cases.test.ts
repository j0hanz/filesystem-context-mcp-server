import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { searchFiles } from '../../../lib/file-operations.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('searchFiles edge cases', () => {
  withFileOpsFixture((getTestDir) => {
    void it('searchFiles handles complex glob patterns', async () => {
      const result = await searchFiles(getTestDir(), '**/*.{ts,md}');
      assert.ok(result.results.length > 0);
    });

    void it('searchFiles handles negation in exclude patterns', async () => {
      const result = await searchFiles(getTestDir(), '**/*', ['**/docs/**']);
      assert.strictEqual(
        result.results.every((r) => !r.path.includes('docs')),
        true
      );
    });
  });
});
