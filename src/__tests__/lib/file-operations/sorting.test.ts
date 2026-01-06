import assert from 'node:assert/strict';
import { it } from 'node:test';

import { sortSearchResults } from '../../../lib/file-operations/sorting.js';

void it('sortSearchResults uses path as a deterministic tie-breaker for name sort', () => {
  const results = [{ path: '/b/file.txt' }, { path: '/a/file.txt' }];

  sortSearchResults(results, 'name');

  assert.deepStrictEqual(
    results.map((item) => item.path),
    ['/a/file.txt', '/b/file.txt']
  );
});
