import { expect, it } from 'vitest';

import { searchFiles } from '../../../lib/file-operations.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('searchFiles handles complex glob patterns', async () => {
  const result = await searchFiles(getTestDir(), '**/*.{ts,md}');
  expect(result.results.length).toBeGreaterThan(0);
});

it('searchFiles handles negation in exclude patterns', async () => {
  const result = await searchFiles(getTestDir(), '**/*', ['**/docs/**']);
  expect(result.results.every((r) => !r.path.includes('docs'))).toBe(true);
});
